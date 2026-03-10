// backend/src/server.js
// Fargate Express server with WebSocket support + Interview Link Generation

import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 8080;
const REGION = process.env.AWS_REGION || 'eu-central-1';
const SESSION_TABLE = process.env.SESSION_TABLE || 'InterviewSessions';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'eu-central-1_JbO8lhpi2';

const polly = new PollyClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const ses = new SESClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || '';
const LINK_SECRET = process.env.LINK_SECRET || 'default-dev-secret-change-in-prod';

function generateLinkToken(interviewId) {
  return crypto.createHmac('sha256', LINK_SECRET).update(interviewId).digest('hex');
}

function verifyLinkToken(interviewId, token) {
  const expected = generateLinkToken(interviewId);
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// JWT verification using Cognito JWKS
const jwks = jwksClient({
  jwksUri: `https://cognito-idp.${REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000, // 10 min
});

function getSigningKey(header, callback) {
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  jwt.verify(token, getSigningKey, { algorithms: ['RS256'] }, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    req.recruiterEmail = decoded.email || decoded['cognito:username'];
    next();
  });
}

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

async function sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink) {
  if (!SES_FROM_EMAIL) return;
  try {
    const htmlBody = `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f6fa;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#6366f1,#a855f7);padding:32px 36px 24px;">
      <div style="font-size:28px;margin-bottom:8px;">&#127919;</div>
      <h1 style="color:#fff;font-size:22px;margin:0 0 4px;">You've been invited to an AI Interview</h1>
      <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:0;">Hello ${candidateName}, a recruiter has set up an AI-powered interview for you.</p>
    </div>
    <div style="padding:28px 36px;">
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 20px;">Click the button below to begin your interview. The AI interviewer will guide you through a series of questions — just speak naturally into your microphone.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${interviewLink}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:16px 36px;border-radius:10px;letter-spacing:0.01em;">&#128279; Click Here to Join Your Interview</a>
      </div>
      <p style="text-align:center;color:#6b7280;font-size:13px;margin:0 0 20px;">or copy and paste the link below into your browser</p>
      <div style="background:#f9fafb;border-radius:10px;padding:16px 18px;margin:20px 0;">
        <p style="font-size:12px;color:#6b7280;margin:0 0 6px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Or copy this link</p>
        <p style="font-size:12px;color:#6366f1;word-break:break-all;margin:0;font-family:monospace;">${interviewLink}</p>
      </div>
      <ul style="color:#6b7280;font-size:13px;line-height:1.8;padding-left:18px;margin:0;">
        <li>Find a quiet space with a good microphone</li>
        <li>This link is valid for 7 days and can only be used once</li>
        <li>Allow microphone access when prompted by your browser</li>
      </ul>
    </div>
    <div style="background:#f9fafb;padding:16px 36px;border-top:1px solid #e5e7eb;">
      <p style="color:#9ca3af;font-size:12px;margin:0;text-align:center;">Sent by AI Interviewer &mdash; do not reply to this email</p>
    </div>
  </div>
</body></html>`;

    await ses.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [candidateEmail] },
      Message: {
        Subject: { Data: `Your AI Interview is Ready — ${candidateName}` },
        Body: {
          Html: { Data: htmlBody },
          Text: { Data: `Hello ${candidateName},\n\nYou have been invited to an AI-powered interview.\n\nClick this link to begin:\n${interviewLink}\n\nThe link is valid for 7 days and can only be used once.\n\nGood luck!` },
        },
      },
    }));
    console.log(`✅ Invitation email sent to ${candidateEmail}`);
  } catch (err) {
    console.error('❌ Failed to send invitation email (non-fatal):', err.message);
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

// Suggest interview questions from CV/JD text
app.post('/interview/suggest-questions', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length < 20) {
      return res.status(400).json({ error: 'Please provide more CV/JD text to generate questions from.' });
    }
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 600,
      temperature: 0.4,
      messages: [{
        role: 'user',
        content: `Based on this CV or job description, generate exactly 3 targeted interview questions that probe the candidate's specific experience and suitability for the role.\n\n${text.slice(0, 4000)}\n\nRules:\n- Each question must be short (1-2 sentences), conversational, and suitable for a voice interview\n- Focus on specific skills, experience, or notable aspects visible in the CV/JD\n- Do NOT include a generic greeting or icebreaker\n- Return ONLY a JSON array of exactly 3 strings, no other text`,
      }],
    };
    const resp = await bedrock.send(new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }));
    const raw = Buffer.from(resp.body).toString('utf-8');
    const parsed = JSON.parse(raw);
    const rawText = parsed?.content?.find(c => c.type === 'text')?.text?.trim() || '[]';
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const questions = JSON.parse(cleaned);
    if (!Array.isArray(questions) || !questions.length) throw new Error('Invalid response format');
    res.json({ questions: questions.slice(0, 3) });
  } catch (err) {
    console.error('Error suggesting questions:', err.message);
    res.status(500).json({ error: 'Failed to generate questions. Please try again.' });
  }
});

// NEW: Create interview link
app.post('/interview/create', requireAuth, async (req, res) => {
  try {
    const { candidateName, jobDescription, customQuestions } = req.body;
    const candidateEmail = (req.body.candidateEmail || '').toLowerCase().trim();
    const recruiterEmail = (req.body.recruiterEmail || '').toLowerCase().trim();
    const validCustomQ = Array.isArray(customQuestions) && customQuestions.length
      ? customQuestions.filter(q => typeof q === 'string' && q.trim()).slice(0, 10).map(q => q.trim())
      : null;

    if (!candidateName || !candidateEmail || !recruiterEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const interviewId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const attendeeId = `att_${Math.random().toString(36).substr(2, 9)}`;
    const linkToken = generateLinkToken(interviewId);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

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
          customQuestions: validCustomQ || null,
          status: 'created',
          createdAt: new Date().toISOString(),
          expiresAt,
        },
      })
    );

    const interviewLink = `https://d5k7p6fyxagls.cloudfront.net/interview.html?id=${interviewId}&token=${linkToken}`;

    // Send invitation email to candidate (non-blocking, non-fatal)
    sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink).catch(() => {});

    console.log(`✅ Created interview link for ${candidateName}`);

    res.json({
      interviewId,
      attendeeId,
      interviewLink,
      candidateName,
      candidateEmail,
      expiresAt,
    });
  } catch (error) {
    console.error('Error creating interview:', error);
    res.status(500).json({ error: 'Failed to create interview link' });
  }
});

// Get public interview result (for candidate thank-you page)
app.get('/interview/result/:interviewId', async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const result = await ddb.send(new GetCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
    }));
    if (!result.Item) return res.status(404).json({ error: 'Interview not found' });
    res.json({
      candidateName: result.Item.candidateName,
      status: result.Item.status,
      completedAt: result.Item.updatedAt || null,
    });
  } catch (error) {
    console.error('Error fetching interview result:', error);
    res.status(500).json({ error: 'Failed to fetch result' });
  }
});

// NEW: Validate interview link
app.get('/interview/validate/:interviewId', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const { token } = req.query;

    if (!token || !verifyLinkToken(interviewId, token)) {
      return res.status(403).json({ error: 'Invalid or missing interview token' });
    }

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
app.get('/interview/sessions', requireAuth, async (req, res) => {
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
      .filter(item => item.pk && item.pk.startsWith('INTERVIEW#') && !item.archived)
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
        expiresAt: item.expiresAt || null,
      }));
    res.json({ sessions });
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Archive (soft-delete) an interview
app.delete('/interview/:interviewId', requireAuth, async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const itemRes = await ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' } }));
    if (!itemRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (itemRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    await ddb.send(new UpdateCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
      UpdateExpression: 'SET archived = :a, updatedAt = :now',
      ExpressionAttributeValues: { ':a': true, ':now': new Date().toISOString() },
    }));
    res.json({ success: true });
  } catch (error) {
    console.error('Error archiving interview:', error);
    res.status(500).json({ error: 'Failed to archive interview' });
  }
});

// Resend invitation email to candidate
app.post('/interview/resend-invite/:interviewId', requireAuth, async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const itemRes = await ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' } }));
    if (!itemRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (itemRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    if (!SES_FROM_EMAIL) return res.status(503).json({ error: 'Email service not configured' });
    const { candidateName, candidateEmail } = itemRes.Item;
    const interviewLink = `https://d5k7p6fyxagls.cloudfront.net/interview.html?id=${interviewId}`;
    await sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink);
    res.json({ success: true });
  } catch (error) {
    console.error('Error resending invite:', error);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

// Regenerate/extend interview link expiry
app.post('/interview/regenerate/:interviewId', requireAuth, async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const itemRes = await ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' } }));
    if (!itemRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (itemRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    if (itemRes.Item.status === 'completed') return res.status(400).json({ error: 'Cannot regenerate a completed interview' });
    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await ddb.send(new UpdateCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
      UpdateExpression: 'SET expiresAt = :exp, #st = :st, updatedAt = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':exp': newExpiry, ':st': 'created', ':now': new Date().toISOString() },
    }));
    const linkToken = generateLinkToken(interviewId);
    const interviewLink = `https://d5k7p6fyxagls.cloudfront.net/interview.html?id=${interviewId}&token=${linkToken}`;
    res.json({ success: true, expiresAt: newExpiry, interviewLink });
  } catch (error) {
    console.error('Error regenerating link:', error);
    res.status(500).json({ error: 'Failed to regenerate link' });
  }
});

// Existing: Process interview transcript
app.post('/interview/process', async (req, res) => {
  try {
    const { meetingId, attendeeId, transcriptText, isInit, token } = req.body;

    if (!meetingId || typeof meetingId !== 'string' || meetingId.length > 100) {
      return res.status(400).json({ error: 'Invalid meetingId' });
    }

    if (!attendeeId || typeof attendeeId !== 'string' || attendeeId.length > 100) {
      return res.status(400).json({ error: 'Invalid attendeeId' });
    }

    // Verify signed link token
    if (!token || !verifyLinkToken(meetingId, token)) {
      return res.status(403).json({ error: 'Unauthorized: invalid interview token' });
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

        // Verify the signed link token before allowing interview to start
        if (!data.token || !verifyLinkToken(mid, data.token)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized: invalid interview token' }));
          ws.close(1008, 'Unauthorized');
          return;
        }

        // Load job description and candidate name from interview metadata
        let jobDescription = null;
        let candidateName = null;
          let customQuestions = null;
          try {
            const metaRes = await ddb.send(new GetCommand({
              TableName: SESSION_TABLE,
              Key: { pk: `INTERVIEW#${mid}`, sk: 'META' },
            }));
            jobDescription = metaRes.Item?.jobDescription || null;
            candidateName = metaRes.Item?.candidateName || null;
            customQuestions = metaRes.Item?.customQuestions || null;
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
            customQuestions,
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
