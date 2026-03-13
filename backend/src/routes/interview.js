// All /interview/* routes. Mounts at /interview.

import { Router } from 'express';
import { GetCommand, PutCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, SESSION_TABLE, FRONTEND_URL } from '../utils/clients.js';
import { requireAuth, generateLinkToken, verifyLinkToken } from '../utils/auth.js';
import { suggestQuestionsFromCV } from '../bedrock-client.js';
import { sendCandidateInvitationEmail } from '../utils/email.js';
import { processTranscript } from '../interview-engine.js';
import { saveInterviewSnapshot, generateSpeech } from '../utils/pipeline.js';

const router = Router();

// ── POST /interview/suggest-questions ─────────────────────────────────────────
router.post('/suggest-questions', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length < 20) {
      return res.status(400).json({ error: 'Please provide more CV/JD text to generate questions from.' });
    }
    const questions = await suggestQuestionsFromCV(text);
    res.json({ questions });
  } catch (err) {
    console.error('Error suggesting questions:', err.message);
    res.status(500).json({ error: 'Failed to generate questions. Please try again.' });
  }
});

// ── POST /interview/create ────────────────────────────────────────────────────
router.post('/create', requireAuth, async (req, res) => {
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
    const attendeeId  = `att_${Math.random().toString(36).substr(2, 9)}`;
    const linkToken   = generateLinkToken(interviewId);
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await ddb.send(new PutCommand({
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
    }));

    const interviewLink = `${FRONTEND_URL}/interview.html?id=${interviewId}&token=${linkToken}`;
    sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink).catch(() => {});

    console.log(`✅ Created interview link for ${candidateName}`);
    res.json({ interviewId, attendeeId, interviewLink, candidateName, candidateEmail, expiresAt });
  } catch (error) {
    console.error('Error creating interview:', error);
    res.status(500).json({ error: 'Failed to create interview link' });
  }
});

// ── GET /interview/result/:interviewId ────────────────────────────────────────
router.get('/result/:interviewId', async (req, res) => {
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

// ── GET /interview/validate/:interviewId ──────────────────────────────────────
router.get('/validate/:interviewId', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const { token } = req.query;

    if (!token || !verifyLinkToken(interviewId, token)) {
      return res.status(403).json({ error: 'Invalid or missing interview token' });
    }

    const result = await ddb.send(new GetCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: `META` },
    }));

    if (!result.Item) return res.status(404).json({ error: 'Interview not found' });
    if (new Date(result.Item.expiresAt) < new Date()) return res.status(410).json({ error: 'Interview link expired' });
    if (result.Item.status === 'completed') return res.status(410).json({ error: 'Interview already completed' });

    res.json({
      valid:         true,
      candidateName: result.Item.candidateName,
      attendeeId:    result.Item.attendeeId,
      interviewId:   result.Item.interviewId,
      jobDescription: result.Item.jobDescription || null,
    });
  } catch (error) {
    console.error('Error validating interview:', error);
    res.status(500).json({ error: 'Failed to validate interview' });
  }
});

// ── GET /interview/sessions ───────────────────────────────────────────────────
router.get('/sessions', requireAuth, async (req, res) => {
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
        interviewId:    item.interviewId,
        candidateName:  item.candidateName,
        candidateEmail: item.candidateEmail,
        status:         item.status,
        createdAt:      item.createdAt,
        score:          item.aiScore || null,
        recommendation: item.aiRecommendation || null,
        summary:        item.aiSummary || null,
        expiresAt:      item.expiresAt || null,
      }));
    res.json({ sessions });
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// ── GET /interview/transcript/:interviewId ────────────────────────────────────
router.get('/transcript/:interviewId', requireAuth, async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const metaRes = await ddb.send(new GetCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
    }));
    if (!metaRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (metaRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    const { attendeeId } = metaRes.Item;
    const stateRes = await ddb.send(new GetCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `MEETING#${interviewId}`, sk: `ATTENDEE#${attendeeId}` },
    }));
    const history = (stateRes.Item || {}).history || [];
    const conversation = history.map((h, i) => ({
      turn: i + 1, question: h.q, candidateAnswer: h.a, aiReply: h.reply, timestamp: h.t,
    }));
    res.json({ conversation, turns: conversation.length });
  } catch (error) {
    console.error('Error fetching transcript:', error);
    res.status(500).json({ error: 'Failed to fetch transcript' });
  }
});

// ── DELETE /interview/:interviewId ────────────────────────────────────────────
router.delete('/:interviewId', requireAuth, async (req, res) => {
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

// ── POST /interview/resend-invite/:interviewId ────────────────────────────────
router.post('/resend-invite/:interviewId', requireAuth, async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const itemRes = await ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' } }));
    if (!itemRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (itemRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    const { candidateName, candidateEmail } = itemRes.Item;
    const interviewLink = `${FRONTEND_URL}/interview.html?id=${interviewId}`;
    await sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink);
    res.json({ success: true });
  } catch (error) {
    console.error('Error resending invite:', error);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

// ── POST /interview/regenerate/:interviewId ───────────────────────────────────
router.post('/regenerate/:interviewId', requireAuth, async (req, res) => {
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
    const linkToken     = generateLinkToken(interviewId);
    const interviewLink = `${FRONTEND_URL}/interview.html?id=${interviewId}&token=${linkToken}`;
    res.json({ success: true, expiresAt: newExpiry, interviewLink });
  } catch (error) {
    console.error('Error regenerating link:', error);
    res.status(500).json({ error: 'Failed to regenerate link' });
  }
});

// ── POST /interview/process ───────────────────────────────────────────────────
router.post('/process', async (req, res) => {
  try {
    const { meetingId, attendeeId, transcriptText, isInit, token } = req.body;

    if (!meetingId || typeof meetingId !== 'string' || meetingId.length > 100) {
      return res.status(400).json({ error: 'Invalid meetingId' });
    }
    if (!attendeeId || typeof attendeeId !== 'string' || attendeeId.length > 100) {
      return res.status(400).json({ error: 'Invalid attendeeId' });
    }
    if (!token || !verifyLinkToken(meetingId, token)) {
      return res.status(403).json({ error: 'Unauthorized: invalid interview token' });
    }
    if (transcriptText && transcriptText.length > 5000) {
      return res.status(400).json({ error: 'Text too long' });
    }

    let jobDescription  = null;
    let candidateName   = null;
    let customQuestions = null;
    if (isInit === true) {
      try {
        const metaRes = await ddb.send(new GetCommand({
          TableName: SESSION_TABLE,
          Key: { pk: `INTERVIEW#${meetingId}`, sk: 'META' },
        }));
        jobDescription  = metaRes.Item?.jobDescription  || null;
        candidateName   = metaRes.Item?.candidateName   || null;
        customQuestions = metaRes.Item?.customQuestions || null;
        console.log(`[/process] init — candidate: "${candidateName}", hasJD: ${!!jobDescription}, customQs: ${customQuestions?.length || 0}`);
      } catch (err) {
        console.error('[/process] Failed to load interview metadata:', err.message);
      }
    }

    const result = await processTranscript({
      meetingId, attendeeId, transcriptText,
      isInit: isInit === true,
      jobDescription, candidateName, customQuestions,
    });

    if (result.done) {
      await saveInterviewSnapshot(meetingId, attendeeId, 'completed');
    }

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

export default router;
