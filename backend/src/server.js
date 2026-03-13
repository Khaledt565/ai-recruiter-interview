// backend/src/server.js
// Fargate Express server — thin shell: middleware, route mounting, WebSocket, HTTPS.

import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { ddb, SESSION_TABLE } from './utils/clients.js';
import { verifyLinkToken } from './utils/auth.js';
import { generateSpeech, saveInterviewSnapshot } from './utils/pipeline.js';
import { processTranscript } from './interview-engine.js';

import jobsRouter, { publicJobsRouter } from './routes/jobs.js';
import applicationsRouter from './routes/applications.js';
import templatesRouter from './routes/templates.js';
import interviewRouter from './routes/interview.js';
import seekerAuthRouter from './routes/seeker-auth.js';
import seekerProfileRouter from './routes/seeker-profile.js';
import seekerApplicationsRouter from './routes/seeker-applications.js';
import notificationsRouter, { seekerNotificationsRouter } from './routes/notifications.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/interview', limiter);
app.use('/applications', limiter);

// ── Route mounting ────────────────────────────────────────────────────────────
app.use('/jobs', jobsRouter);
app.use('/public/jobs', publicJobsRouter);
app.use('/applications', applicationsRouter);
app.use('/question-templates', templatesRouter);
app.use('/interview', interviewRouter);
app.use('/seeker/auth', seekerAuthRouter);
app.use('/seeker', seekerProfileRouter);
app.use('/seeker', seekerApplicationsRouter);
app.use('/notifications', notificationsRouter);
app.use('/seeker/notifications', seekerNotificationsRouter);

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    message: 'GitHub Actions deployment - credentials corrected',
  });
});

// Load HTTPS certificate and key
const certPath = path.join(__dirname, '../certs/server.crt');
const keyPath = path.join(__dirname, '../certs/server.key');
const USE_HTTPS = process.env.USE_HTTPS !== 'false' && fs.existsSync(certPath) && fs.existsSync(keyPath);

let server;
if (USE_HTTPS) {
  const options = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
  server = https.createServer(options, app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\u{1F680} Interview server running SECURELY on https://0.0.0.0:${PORT}`);
    console.log(`\u{1F510} Certificate: ${certPath}`);
  });
} else {
  console.warn('\u26A0\uFE0F  Using HTTP (development mode)');
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\u{1F680} Interview server running on http://0.0.0.0:${PORT}`);
  });
}

// WebSocket server for real-time communication
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  let meetingId = null;
  let attendeeId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'connect') {
        meetingId = data.meetingId;
        attendeeId = data.attendeeId;
        console.log(`Connected: ${meetingId}/${attendeeId}`);
        ws.send(JSON.stringify({ type: 'connected', meetingId, attendeeId }));
        return;
      }

      if (data.type === 'end') {
        if (meetingId && attendeeId) {
          await saveInterviewSnapshot(meetingId, attendeeId, 'ended_by_candidate');
        }
        ws.send(JSON.stringify({ type: 'ended' }));
        return;
      }

      if (data.type === 'init') {
        const mid = meetingId || data.meetingId;
        const aid = attendeeId || data.attendeeId;

        if (!data.token || !verifyLinkToken(mid, data.token)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized: invalid interview token' }));
          ws.close(1008, 'Unauthorized');
          return;
        }

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
        const audioBuffer = await generateSpeech(result.spokenText);
        ws.send(JSON.stringify({
          type: 'response',
          spokenText: result.spokenText,
          audioBase64: audioBuffer.toString('base64'),
          done: result.done,
          qIndex: result.qIndex,
        }));
        return;
      }

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
        const audioBuffer = await generateSpeech(result.spokenText);
        ws.send(JSON.stringify({
          type: 'response',
          spokenText: result.spokenText,
          audioBase64: audioBuffer.toString('base64'),
          done: result.done,
          qIndex: result.qIndex,
        }));

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
    if (meetingId && attendeeId) {
      await saveInterviewSnapshot(meetingId, attendeeId, 'disconnected');
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
