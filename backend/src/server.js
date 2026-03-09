// backend/src/server.js
// Fargate Express server with WebSocket support + Interview Link Generation

import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { processTranscript, QUESTIONS, generateCandidateSummary } from './interview-engine.js';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 8080;
const REGION = process.env.AWS_REGION || 'eu-central-1';
const SESSION_TABLE = process.env.SESSION_TABLE || 'InterviewSessions';

const polly = new PollyClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const ses = new SESClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || '';

app.use(cors());
app.use(express.json());

// Save full interview conversation to S3 (called on completion, disconnection, or explicit end)
async function saveInterviewSnapshot(meetingId, attendeeId, status) {
  try {
    const [stateRes, metaRes] = await Promise.all([
      ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `MEETING#${meetingId}`, sk: `ATTENDEE#${attendeeId}` } })),
      ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${meetingId}`, sk: `META` } })),
    ]);
    const state = stateRes.Item || {};
    const meta = metaRes.Item || {};

    // Generate AI summary only for completed interviews with conversation history
    let aiSummary = null;
    if (status === 'completed' && state.history && state.history.length > 0) {
      try {
        aiSummary = await generateCandidateSummary(
          state.history,
          meta.candidateName || 'Unknown',
          state.jobDescription || meta.jobDescription || null,
        );
        console.log(`✅ AI summary generated for ${meetingId}: ${aiSummary?.recommendation} (${aiSummary?.score}/10)`);
      } catch (err) {
        console.error('❌ Failed to generate AI summary:', err);
      }
    }

    const snapshot = {
      interviewId: meetingId,
      candidateName: meta.candidateName || 'Unknown',
      candidateEmail: meta.candidateEmail || '',
      recruiterEmail: meta.recruiterEmail || '',
      status,
      savedAt: new Date().toISOString(),
      startedAt: state.startedAt || null,
      createdAt: meta.createdAt || null,
      questionsAnswered: state.qIndex || 0,
      totalQuestions: (state.questions || QUESTIONS).length,
      completed: state.done || false,
      jobDescription: state.jobDescription || meta.jobDescription || null,
      aiSummary,
      conversation: (state.history || []).map((h, i) => ({
        turn: i + 1,
        question: h.q,
        candidateAnswer: h.a,
        aiReply: h.reply,
        timestamp: h.t,
      })),
    };

    await s3.send(new PutObjectCommand({
      Bucket: 'ai-recruiter-interviews-090605004529',
      Key: `interviews/${meetingId}/${status}-${Date.now()}.json`,
      Body: JSON.stringify(snapshot, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));

    // Build DynamoDB update expression — optionally store AI summary fields
    let updateExpr = 'SET #st = :status, updatedAt = :now';
    const exprNames = { '#st': 'status' };
    const exprValues = { ':status': status, ':now': new Date().toISOString() };
    if (aiSummary) {
      updateExpr += ', aiScore = :score, aiRecommendation = :rec, aiSummary = :summary';
      exprValues[':score'] = aiSummary.score;
      exprValues[':rec'] = aiSummary.recommendation;
      exprValues[':summary'] = aiSummary.summary;
    }

    await ddb.send(new UpdateCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${meetingId}`, sk: `META` },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }));

    // Notify recruiter by email when interview completes
    if (status === 'completed' && meta.recruiterEmail && SES_FROM_EMAIL) {
      await sendRecruiterEmail(meta.recruiterEmail, meta.candidateName, aiSummary, meetingId);
    }

    console.log(`✅ Interview snapshot saved (${meetingId}, status: ${status}, turns: ${snapshot.conversation.length})`);
  } catch (err) {
    console.error('❌ Failed to save interview snapshot:', err);
  }
}

async function sendRecruiterEmail(recruiterEmail, candidateName, summary, interviewId) {
  try {
    const rec = summary?.recommendation || 'N/A';
    const score = summary?.score != null ? `${summary.score}/10` : 'N/A';
    const summaryText = summary?.summary || 'No summary available.';
    const strengths = (summary?.strengths || []).map(s => `  • ${s}`).join('\n');
    const concerns = (summary?.concerns || []).map(c => `  • ${c}`).join('\n');

    const bodyLines = [
      `Interview completed: ${candidateName}`,
      `Interview ID: ${interviewId}`,
      ``,
      `Recommendation: ${rec}`,
      `Score: ${score}`,
      ``,
      `Summary:`,
      summaryText,
    ];
    if (strengths) bodyLines.push(``, `Strengths:`, strengths);
    if (concerns) bodyLines.push(``, `Concerns:`, concerns);
    bodyLines.push(``, `View full transcript in your recruiter dashboard.`);

    await ses.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [recruiterEmail] },
      Message: {
        Subject: { Data: `Interview Complete: ${candidateName} — ${rec}` },
        Body: { Text: { Data: bodyLines.join('\n') } },
      },
    }));
    console.log(`✅ Recruiter email sent to ${recruiterEmail}`);
  } catch (err) {
    console.error('❌ Failed to send recruiter email (non-fatal):', err.message);
  }
}

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/interview', limiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    message: 'GitHub Actions deployment - credentials corrected'
  });
});

// NEW: Create interview link
app.post('/interview/create', async (req, res) => {
  try {
    const { candidateName, candidateEmail, recruiterEmail, jobDescription } = req.body;

    if (!candidateName || !candidateEmail || !recruiterEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const interviewId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const attendeeId = `att_${Math.random().toString(36).substr(2, 9)}`;

    await ddb.send(
      new PutCommand({
        TableName: SESSION_TABLE,
        Item: {
          pk: `INTERVIEW#${interviewId}`,
          sk: `META`,
          interviewId,
          attendeeId,
          candidateName,
          candidateEmail,
          recruiterEmail,
          jobDescription: jobDescription || null,
          status: 'created',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
      })
    );

    const interviewLink = `https://d5k7p6fyxagls.cloudfront.net/interview.html?id=${interviewId}`;

    console.log(`✅ Created interview link for ${candidateName}`);

    res.json({
      interviewId,
      attendeeId,
      interviewLink,
      candidateName,
      candidateEmail,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    console.error('Error creating interview:', error);
    res.status(500).json({ error: 'Failed to create interview link' });
  }
});

// NEW: Validate interview link
app.get('/interview/validate/:interviewId', async (req, res) => {
  try {
    const { interviewId } = req.params;

    const result = await ddb.send(
      new GetCommand({
        TableName: SESSION_TABLE,
        Key: {
          pk: `INTERVIEW#${interviewId}`,
          sk: `META`,
        },
      })
    );

    if (!result.Item) {
      return res.status(404).json({ error: 'Interview not found' });
    }

    if (new Date(result.Item.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'Interview link expired' });
    }

    if (result.Item.status === 'completed') {
      return res.status(410).json({ error: 'Interview already completed' });
    }

    res.json({
      valid: true,
      candidateName: result.Item.candidateName,
      attendeeId: result.Item.attendeeId,
      interviewId: result.Item.interviewId,
      jobDescription: result.Item.jobDescription || null,
    });
  } catch (error) {
    console.error('Error validating interview:', error);
    res.status(500).json({ error: 'Failed to validate interview' });
  }
});

// List interview sessions for a recruiter
app.get('/interview/sessions', async (req, res) => {
  try {
    const { recruiterEmail } = req.query;
    if (!recruiterEmail || typeof recruiterEmail !== 'string') {
      return res.status(400).json({ error: 'recruiterEmail query param is required' });
    }
    const result = await ddb.send(new ScanCommand({
      TableName: SESSION_TABLE,
      FilterExpression: 'recruiterEmail = :email AND sk = :meta',
      ExpressionAttributeValues: { ':email': recruiterEmail, ':meta': 'META' },
    }));
    const sessions = (result.Items || [])
      .filter(item => item.pk && item.pk.startsWith('INTERVIEW#'))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map(item => ({
        interviewId: item.interviewId,
        candidateName: item.candidateName,
        candidateEmail: item.candidateEmail,
        status: item.status,
        createdAt: item.createdAt,
        score: item.aiScore || null,
        recommendation: item.aiRecommendation || null,
        summary: item.aiSummary || null,
      }));
    res.json({ sessions });
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Existing: Process interview transcript
app.post('/interview/process', async (req, res) => {
  try {
    const { meetingId, attendeeId, transcriptText, isInit } = req.body;

    if (!meetingId || typeof meetingId !== 'string' || meetingId.length > 100) {
      return res.status(400).json({ error: 'Invalid meetingId' });
    }

    if (!attendeeId || typeof attendeeId !== 'string' || attendeeId.length > 100) {
      return res.status(400).json({ error: 'Invalid attendeeId' });
    }

    if (transcriptText && transcriptText.length > 5000) {
      return res.status(400).json({ error: 'Text too long' });
    }

    const result = await processTranscript({
      meetingId,
      attendeeId,
      transcriptText,
      isInit: isInit === true,
    });

    // Save full conversation to S3 when interview is done
    if (result.done) {
      await saveInterviewSnapshot(meetingId, attendeeId, 'completed');
    }

    // Generate audio if requested
    if (req.query.withAudio === 'true' && result.spokenText) {
      const audioData = await generateSpeech(result.spokenText);
      result.audioBase64 = audioData.toString('base64');
    }

    res.json(result);
  } catch (error) {
    console.error('Error processing interview:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Load HTTPS certificate and key
const certPath = path.join(__dirname, '../certs/server.crt');
const keyPath = path.join(__dirname, '../certs/server.key');
const USE_HTTPS = process.env.USE_HTTPS !== 'false' && fs.existsSync(certPath) && fs.existsSync(keyPath);

let server;
if (USE_HTTPS) {
  // Production: Use HTTPS with certificate
  const options = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
  server = https.createServer(options, app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Interview server running SECURELY on https://0.0.0.0:${PORT}`);
    console.log(`📝 Certificate: ${certPath}`);
  });
} else {
  // Development/Testing: Use HTTP
  console.warn('⚠️  Using HTTP (development mode)');
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Interview server running on http://0.0.0.0:${PORT}`);
  });
}

// WebSocket server for real-time communication
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection');

  let meetingId = null;
  let attendeeId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      // Handle connection setup
      if (data.type === 'connect') {
        meetingId = data.meetingId;
        attendeeId = data.attendeeId;
        console.log(`Connected: ${meetingId}/${attendeeId}`);
        ws.send(JSON.stringify({ type: 'connected', meetingId, attendeeId }));
        return;
      }

      // Handle explicit end from candidate (stop button)
      if (data.type === 'end') {
        if (meetingId && attendeeId) {
          await saveInterviewSnapshot(meetingId, attendeeId, 'ended_by_candidate');
        }
        ws.send(JSON.stringify({ type: 'ended' }));
        return;
      }

      // Handle initialization
      if (data.type === 'init') {
        const mid = meetingId || data.meetingId;
        const aid = attendeeId || data.attendeeId;

        // Load job description and candidate name from interview metadata
        let jobDescription = null;
        let candidateName = null;
        try {
          const metaRes = await ddb.send(new GetCommand({
            TableName: SESSION_TABLE,
            Key: { pk: `INTERVIEW#${mid}`, sk: 'META' },
          }));
          jobDescription = metaRes.Item?.jobDescription || null;
          candidateName = metaRes.Item?.candidateName || null;
        } catch (err) {
          console.error('Could not load interview metadata for init:', err);
        }

        const result = await processTranscript({
          meetingId: mid,
          attendeeId: aid,
          transcriptText: '',
          isInit: true,
          jobDescription,
          candidateName,
        });

        // Generate audio
        const audioBuffer = await generateSpeech(result.spokenText);

        ws.send(
          JSON.stringify({
            type: 'response',
            spokenText: result.spokenText,
            audioBase64: audioBuffer.toString('base64'),
            done: result.done,
            qIndex: result.qIndex,
          })
        );
        return;
      }

      // Handle transcript
      if (data.type === 'transcript') {
        if (!meetingId || !attendeeId) {
          ws.send(JSON.stringify({ type: 'error', error: 'Not connected' }));
          return;
        }

        const result = await processTranscript({
          meetingId,
          attendeeId,
          transcriptText: data.text,
          isInit: false,
        });

        // Generate audio response
        const audioBuffer = await generateSpeech(result.spokenText);

        ws.send(
          JSON.stringify({
            type: 'response',
            spokenText: result.spokenText,
            audioBase64: audioBuffer.toString('base64'),
            done: result.done,
            qIndex: result.qIndex,
          })
        );

        // Save snapshot when interview completes via WebSocket
        if (result.done) {
          await saveInterviewSnapshot(meetingId, attendeeId, 'completed');
        }
      }
    } catch (error) {
      console.error('WebSocket error:', error);
      ws.send(JSON.stringify({ type: 'error', error: error.message }));
    }
  });

  ws.on('close', async () => {
    console.log(`WebSocket closed: ${meetingId}/${attendeeId}`);
    // Save snapshot on disconnect (connection lost, browser closed, etc.)
    // Only save if interview was actually started (meetingId set during 'connect')
    if (meetingId && attendeeId) {
      await saveInterviewSnapshot(meetingId, attendeeId, 'disconnected');
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Generate speech using Polly
async function generateSpeech(text) {
  const command = new SynthesizeSpeechCommand({
    Text: text,
    OutputFormat: 'mp3',
    VoiceId: 'Joanna',
    Engine: 'neural',
  });

  const response = await polly.send(command);
  const chunks = [];

  for await (const chunk of response.AudioStream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
