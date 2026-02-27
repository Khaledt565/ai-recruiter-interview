// backend/src/server.js
// Fargate Express server with WebSocket support

import express from 'express';
import { WebSocketServer } from 'ws';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { processTranscript } from './interview-engine.js';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8080;
const REGION = process.env.AWS_REGION || 'eu-central-1';

const polly = new PollyClient({ region: REGION });

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// HTTP endpoint (fallback - for testing)
app.post('/interview/process', async (req, res) => {
  try {
    const { meetingId, attendeeId, transcriptText, isInit } = req.body;

    if (!meetingId || !attendeeId) {
      return res.status(400).json({ error: 'Missing meetingId or attendeeId' });
    }

    const result = await processTranscript({
      meetingId,
      attendeeId,
      transcriptText,
      isInit: isInit === true,
    });

    // Optionally generate audio
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

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Interview server running on port ${PORT}`);
});

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
