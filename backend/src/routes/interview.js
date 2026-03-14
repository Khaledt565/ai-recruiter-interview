// All /interview/* routes. Mounts at /interview.

import { Router } from 'express';
import { GetCommand, PutCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SESSION_TABLE, FRONTEND_URL } from '../utils/clients.js';
import { ddbSend } from '../utils/aws-wrappers.js';
import { requireAuth, generateLinkToken, verifyLinkToken } from '../utils/auth.js';
import { suggestQuestionsFromCV } from '../bedrock-client.js';
import { sendCandidateInvitationEmail } from '../utils/email.js';
import { processTranscript } from '../interview-engine.js';
import { saveInterviewSnapshot, generateSpeechWithFallback } from '../utils/pipeline.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ERROR_CODES } from '../utils/errors.js';
import { loadState } from '../session-store.js';

const router = Router();

// ── POST /interview/suggest-questions ─────────────────────────────────────────
router.post('/suggest-questions', requireAuth, asyncHandler(async (req, res) => {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length < 20) {
      return res.status(400).json({ error: 'Please provide more CV/JD text to generate questions from.' });
    }
    const questions = await suggestQuestionsFromCV(text);
    res.json({ questions });
}));

// ── POST /interview/create ────────────────────────────────────────────────────
router.post('/create', requireAuth, asyncHandler(async (req, res) => {
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

    await ddbSend(new PutCommand({
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
}));

// ── GET /interview/result/:interviewId ────────────────────────────────────────
router.get('/result/:interviewId', asyncHandler(async (req, res) => {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const result = await ddbSend(new GetCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
    }));
    if (!result.Item) return res.status(404).json({ error: 'Interview not found' });
    res.json({
      candidateName: result.Item.candidateName,
      status: result.Item.status,
      completedAt: result.Item.updatedAt || null,
    });
}));

// ── GET /interview/validate/:interviewId ──────────────────────────────────────
router.get('/validate/:interviewId', asyncHandler(async (req, res) => {
    const { interviewId } = req.params;
    const { token } = req.query;

    // ── 1. HMAC signature check ──────────────────────────────────────────────
    if (!token || !verifyLinkToken(interviewId, token)) {
      return res.status(403).json({
        code: ERROR_CODES.TOKEN_INVALID,
        error: "This link doesn't seem to be valid. Please check your email or contact the recruiter.",
      });
    }

    const metaRes = await ddbSend(new GetCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
    }));

    // ── 2. Token not found in database ──────────────────────────────────────
    if (!metaRes.Item) {
      return res.status(404).json({
        code: ERROR_CODES.TOKEN_INVALID,
        error: "This link doesn't seem to be valid. Please check your email or contact the recruiter.",
      });
    }

    const meta = metaRes.Item;
    const now  = new Date().toISOString();

    // ── 3. Link expired — persist the status change and reject ──────────────
    if (new Date(meta.expiresAt) < new Date()) {
      if (meta.status !== 'expired') {
        ddbSend(new UpdateCommand({
          TableName: SESSION_TABLE,
          Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
          UpdateExpression: 'SET #st = :s, updatedAt = :now',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: { ':s': 'expired', ':now': now },
        })).catch(e => console.error('[validate] Failed to mark expired:', e.message));
      }
      return res.status(410).json({
        code: ERROR_CODES.TOKEN_EXPIRED,
        error: 'This interview link has expired. Please contact the recruiter to request a new one.',
      });
    }

    // ── 4. Already completed or pending report generation ───────────────────
    if (meta.status === 'completed' || meta.status === 'pending_report') {
      return res.status(410).json({
        code: ERROR_CODES.INTERVIEW_ALREADY_COMPLETE,
        error: "You've already completed this interview. Your results have been sent to the recruiter.",
      });
    }

    // ── 5. In-progress — try to resume from last unanswered question ─────────
    if (meta.status === 'in_progress') {
      let attendeeState = null;
      try {
        const stateRes = await ddbSend(new GetCommand({
          TableName: SESSION_TABLE,
          Key: { pk: `MEETING#${interviewId}`, sk: `ATTENDEE#${meta.attendeeId}` },
        }));
        attendeeState = stateRes.Item || null;
      } catch { /* fall through to fresh-start branch below */ }

      if (attendeeState?.started && Array.isArray(attendeeState.questions) && attendeeState.questions.length > 0 && !attendeeState.done) {
        const totalQuestions  = attendeeState.questions.length;
        const currentQuestion = attendeeState.qIndex + 1; // 1-based for display
        return res.json({
          valid:          true,
          resuming:       true,
          candidateName:  meta.candidateName,
          attendeeId:     meta.attendeeId,
          interviewId:    meta.interviewId,
          jobDescription: meta.jobDescription || null,
          currentQuestion,
          totalQuestions,
          welcomeMessage: `Welcome back \u2014 you're on question ${currentQuestion} of ${totalQuestions}. Pick up where you left off.`,
        });
      }
      // Attendee state not yet initialised (e.g. crashed before first /process call)
      // Fall through and return a fresh-start response without re-writing META
    }

    // ── 6. Valid fresh start — mark in_progress + record startedAt ───────────
    if (meta.status !== 'in_progress') {
      await ddbSend(new UpdateCommand({
        TableName: SESSION_TABLE,
        Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
        UpdateExpression: 'SET #st = :s, startedAt = :now, updatedAt = :now',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':s': 'in_progress', ':now': now },
      }));
    }

    return res.json({
      valid:          true,
      resuming:       false,
      candidateName:  meta.candidateName,
      attendeeId:     meta.attendeeId,
      interviewId:    meta.interviewId,
      jobDescription: meta.jobDescription || null,
    });
}));

// ── GET /interview/sessions ───────────────────────────────────────────────────
router.get('/sessions', requireAuth, asyncHandler(async (req, res) => {
    const { recruiterEmail } = req.query;
    if (!recruiterEmail || typeof recruiterEmail !== 'string') {
      return res.status(400).json({ error: 'recruiterEmail query param is required' });
    }
    const result = await ddbSend(new ScanCommand({
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
}));

// ── GET /interview/transcript/:interviewId ────────────────────────────────────
router.get('/transcript/:interviewId', requireAuth, asyncHandler(async (req, res) => {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const metaRes = await ddbSend(new GetCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
    }));
    if (!metaRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (metaRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    const { attendeeId } = metaRes.Item;
    const stateRes = await ddbSend(new GetCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `MEETING#${interviewId}`, sk: `ATTENDEE#${attendeeId}` },
    }));
    const history = (stateRes.Item || {}).history || [];
    const conversation = history.map((h, i) => ({
      turn: i + 1, question: h.q, candidateAnswer: h.a, aiReply: h.reply, timestamp: h.t,
    }));
    res.json({ conversation, turns: conversation.length });
}));

// ── DELETE /interview/:interviewId ────────────────────────────────────────────
router.delete('/:interviewId', requireAuth, asyncHandler(async (req, res) => {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const itemRes = await ddbSend(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' } }));
    if (!itemRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (itemRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    await ddbSend(new UpdateCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
      UpdateExpression: 'SET archived = :a, updatedAt = :now',
      ExpressionAttributeValues: { ':a': true, ':now': new Date().toISOString() },
    }));
    res.json({ success: true });
}));

// ── POST /interview/resend-invite/:interviewId ────────────────────────────────
router.post('/resend-invite/:interviewId', requireAuth, asyncHandler(async (req, res) => {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const itemRes = await ddbSend(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' } }));
    if (!itemRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (itemRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    const { candidateName, candidateEmail } = itemRes.Item;
    const interviewLink = `${FRONTEND_URL}/interview.html?id=${interviewId}`;
    await sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink);
    res.json({ success: true });
}));

// ── POST /interview/regenerate/:interviewId ───────────────────────────────────
router.post('/regenerate/:interviewId', requireAuth, asyncHandler(async (req, res) => {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const itemRes = await ddbSend(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' } }));
    if (!itemRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (itemRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    if (itemRes.Item.status === 'completed') return res.status(400).json({ error: 'Cannot regenerate a completed interview' });
    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await ddbSend(new UpdateCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
      UpdateExpression: 'SET expiresAt = :exp, #st = :st, updatedAt = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':exp': newExpiry, ':st': 'created', ':now': new Date().toISOString() },
    }));
    const linkToken     = generateLinkToken(interviewId);
    const interviewLink = `${FRONTEND_URL}/interview.html?id=${interviewId}&token=${linkToken}`;
    res.json({ success: true, expiresAt: newExpiry, interviewLink });
}));

// ── POST /interview/process ───────────────────────────────────────────────────
router.post('/process', asyncHandler(async (req, res) => {
    const { meetingId, attendeeId, transcriptText, isInit, token, questionIndex } = req.body;

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
        const metaRes = await ddbSend(new GetCommand({
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

    // ── Duplicate-answer guard ───────────────────────────────────────────────
    // If the client includes questionIndex (the index of the question being answered),
    // detect replayed requests for questions already recorded and return next question.
    if (!isInit && typeof questionIndex === 'number') {
      let existingState = null;
      try { existingState = await loadState(meetingId, attendeeId); } catch { /* best-effort */ }
      if (existingState && typeof existingState.qIndex === 'number' && questionIndex < existingState.qIndex) {
        const nextQ = (existingState.questions || [])[existingState.qIndex] || '';
        return res.json({ spokenText: nextQ, done: existingState.done || false, qIndex: existingState.qIndex });
      }
    }

    const result = await processTranscript({
      meetingId, attendeeId, transcriptText,
      isInit: isInit === true,
      jobDescription, candidateName, customQuestions,
    });

    if (result.done) {
      await saveInterviewSnapshot(meetingId, attendeeId, 'completed');
      result.completionMessage = "Your interview is complete. We're processing your results \u2014 the recruiter will be notified shortly.";
    }

    if (req.query.withAudio === 'true' && result.spokenText) {
      const audioData = await generateSpeechWithFallback(result.spokenText, meetingId);
      result.audioBase64 = audioData ? audioData.toString('base64') : null;
      if (!audioData) result.textMode = true;
    }

    res.json(result);
}));

export default router;
