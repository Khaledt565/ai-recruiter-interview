// backend/src/server.js
// Fargate Express server with WebSocket support + Interview Link Generation

import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { processTranscript } from './interview-engine.js';
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
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

app.use(cors());
app.use(express.json());

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
    version: '1.3.0',
    message: 'GitHub Actions deployment - YAML fixed'
  });
});

// NEW: Create interview link
app.post('/interview/create', async (req, res) => {
  try {
    const { candidateName, candidateEmail, recruiterEmail } = req.body;

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
    });
  } catch (error) {
    console.error('Error validating interview:', error);
    res.status(500).json({ error: 'Failed to validate interview' });
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

    // Save to S3 when interview is done
    if (result.done) {
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: 'ai-recruiter-interviews-090605004529',
            Key: `interviews/${meetingId}-${Date.now()}.json`,
            Body: JSON.stringify({
              meetingId,
              attendeeId,
              timestamp: new Date().toISOString(),
              completed: true,
            }),
            ServerSideEncryption: 'AES256',
          })
        );

        // Mark interview as completed in DynamoDB
        await ddb.send(
          new PutCommand({
            TableName: SESSION_TABLE,
            Item: {
              pk: `INTERVIEW#${meetingId}`,
              sk: `META`,
              status: 'completed',
              completedAt: new Date().toISOString(),
            },
          })
        );

        console.log('✅ Saved completed interview to S3 and DynamoDB');
      } catch (saveError) {
        console.error('Save error:', saveError);
      }
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

      // Handle initialization
      if (data.type === 'init') {
        const result = await processTranscript({
          meetingId: meetingId || data.meetingId,
          attendeeId: attendeeId || data.attendeeId,
          transcriptText: '',
          isInit: true,
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
      }
    } catch (error) {
      console.error('WebSocket error:', error);
      ws.send(JSON.stringify({ type: 'error', error: error.message }));
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket closed: ${meetingId}/${attendeeId}`);
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
