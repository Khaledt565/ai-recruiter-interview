// Application submission and recruiter pipeline management.
// Mounts at /applications.

import { Router } from 'express';
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ddb,
  JOBS_TABLE, APPLICATIONS_TABLE, AI_SESSIONS_TABLE, QUESTION_TEMPLATES_TABLE,
  SESSION_TABLE, INTERVIEW_REPORTS_TABLE, MESSAGES_TABLE,
  FRONTEND_URL,
} from '../utils/clients.js';
import { requireAuth, generateLinkToken } from '../utils/auth.js';
import { scoreProfileWithAI } from '../bedrock-client.js';
import { sendCandidateInvitationEmail, sendRecruiterLowScoreEmail } from '../utils/email.js';
import { createNotification, notifyStatusChange } from '../utils/notifications.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

const VALID_PIPELINE_STATUSES = [
  'applied', 'interview_invited', 'ai_interview_complete', 'recommended',
  'shortlisted', 'human_interview', 'offered', 'hired', 'rejected',
];

// ─────────────────────────────────────────────────────────────────────────────
// POST /applications
// Seeker submits application, AI scores profile, auto-invites if above threshold.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
    const { jobId, seekerId, candidateName, candidateEmail, cvText, coverLetter } = req.body;

    if (!jobId || !seekerId || !candidateName || !candidateEmail || !cvText) {
      return res.status(400).json({ error: 'jobId, seekerId, candidateName, candidateEmail, and cvText are required' });
    }
    if (typeof cvText !== 'string' || cvText.length > 20000) {
      return res.status(400).json({ error: 'cvText must be a string under 20000 characters' });
    }

    const jobRes = await ddb.send(new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: 'JobsByJobId',
      KeyConditionExpression: 'jobId = :jid',
      ExpressionAttributeValues: { ':jid': jobId },
      Limit: 1,
    }));
    const job = jobRes.Items && jobRes.Items[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'open') return res.status(400).json({ error: 'Job is not accepting applications' });

    const scoreThreshold          = typeof job.scoreThreshold === 'number' ? job.scoreThreshold : 50;
    const interviewMode            = job.interviewMode || 'auto';
    const jobDescription           = job.description || '';
    const recruiterEmail           = job.recruiterId || '';
    const jobTitle                 = job.title || 'this role';
    const recommendationThreshold  = typeof job.recommendationThreshold === 'number' ? job.recommendationThreshold : 75;

    const { score: aiProfileScore, reasoning } = await scoreProfileWithAI(jobDescription, cvText);
    console.log(`[Applications] ${candidateName} scored ${aiProfileScore}/100 (threshold: ${scoreThreshold})`);

    const applicationId  = `app_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now            = new Date().toISOString();
    const initialStatus  = aiProfileScore >= scoreThreshold ? 'interview_invited' : 'applied';

    await ddb.send(new PutCommand({
      TableName: APPLICATIONS_TABLE,
      Item: {
        pk: `JOB#${jobId}`,
        sk: `APPLICATION#${applicationId}`,
        applicationId,
        jobId,
        seekerId,
        recruiterId: recruiterEmail,
        candidateName,
        candidateEmail: candidateEmail.toLowerCase().trim(),
        coverLetter: coverLetter || null,
        cvText,
        aiProfileScore,
        aiProfileReasoning: reasoning,
        status: initialStatus,
        recommended: false,
        appliedAt: now,
        updatedAt: now,
      },
    }));

    // Always notify recruiter of new application (in-app)
    createNotification(recruiterEmail, 'new_application', applicationId, jobId,
      `New application – ${candidateName}`,
      ` applied for ${jobTitle}. AI score: ${aiProfileScore}/100`,
    ).catch(() => {});

    if (aiProfileScore < scoreThreshold) {
      sendRecruiterLowScoreEmail(recruiterEmail, candidateName, jobTitle, aiProfileScore, applicationId).catch(() => {});
      return res.status(201).json({
        applicationId,
        status: 'applied',
        aiProfileScore,
        message: 'Application received. Score is below the auto-invite threshold.',
      });
    }

    // Resolve interview questions based on interviewMode
    let customQuestions = null;
    if (interviewMode === 'template' && job.questionTemplateId) {
      const tplRes = await ddb.send(new QueryCommand({
        TableName: QUESTION_TEMPLATES_TABLE,
        IndexName: 'TemplateById',
        KeyConditionExpression: 'templateId = :tid',
        ExpressionAttributeValues: { ':tid': job.questionTemplateId },
        Limit: 1,
      }));
      const tpl = tplRes.Items && tplRes.Items[0];
      if (tpl && Array.isArray(tpl.questions) && tpl.questions.length) {
        customQuestions = tpl.questions.slice(0, 10);
        console.log(`[Applications] Loaded ${customQuestions.length} template questions`);
      }
    } else if (interviewMode === 'custom' && Array.isArray(job.customQuestions) && job.customQuestions.length) {
      customQuestions = job.customQuestions.slice(0, 10);
      console.log(`[Applications] Using ${customQuestions.length} custom questions from job`);
    }

    const interviewId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const attendeeId  = `att_${Math.random().toString(36).substr(2, 9)}`;
    const sessionId   = `sess_${Math.random().toString(36).substr(2, 9)}`;
    const linkToken   = generateLinkToken(interviewId);
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await ddb.send(new PutCommand({
      TableName: AI_SESSIONS_TABLE,
      Item: {
        pk: `APPLICATION#${applicationId}`,
        sk: `SESSION#${sessionId}`,
        sessionId,
        applicationId,
        interviewId,
        inviteToken: linkToken,
        mode: interviewMode,
        state: 'pending',
        expiresAt,
        scheduledAt: now,
        startedAt: null,
        completedAt: null,
      },
    }));

    await ddb.send(new PutCommand({
      TableName: SESSION_TABLE,
      Item: {
        pk: `INTERVIEW#${interviewId}`,
        sk: 'META',
        interviewId,
        attendeeId,
        candidateName,
        candidateEmail: candidateEmail.toLowerCase().trim(),
        recruiterEmail,
        jobDescription: jobDescription || null,
        customQuestions: customQuestions || null,
        applicationId,
        jobId,
        jobTitle,
        recommendationThreshold,
        status: 'created',
        createdAt: now,
        expiresAt,
      },
    }));

    const interviewLink = `${FRONTEND_URL}/interview.html?id=${interviewId}&token=${linkToken}`;
    sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink).catch(() => {});
    createNotification(seekerId, 'interview_invited', applicationId, jobId,
      `Interview invitation – ${jobTitle}`,
      `You've been invited to an AI interview for ${jobTitle}`,
    ).catch(() => {});

    console.log(`✅ Auto-invited ${candidateName} (score ${aiProfileScore}/100, mode: ${interviewMode})`);

    res.status(201).json({
      applicationId,
      interviewId,
      interviewLink,
      status: 'interview_invited',
      aiProfileScore,
      interviewMode,
      expiresAt,
    });
}));

// ── GET /applications ──────────────────────────────────────────────────────────
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const result = await ddb.send(new QueryCommand({
      TableName: APPLICATIONS_TABLE,
      IndexName: 'ApplicationsByRecruiter',
      KeyConditionExpression: 'recruiterId = :rid',
      ExpressionAttributeValues: { ':rid': req.recruiterEmail },
    }));
    res.json({ applications: result.Items || [] });
}));

// ── PATCH /applications/:applicationId/status ──────────────────────────────────
router.patch('/:applicationId/status', requireAuth, asyncHandler(async (req, res) => {
    const { applicationId } = req.params;
    const { status, jobId } = req.body;
    if (!status || !VALID_PIPELINE_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid or missing status' });
    }
    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ error: 'jobId is required' });
    }
    const appItemRes = await ddb.send(new GetCommand({
      TableName: APPLICATIONS_TABLE,
      Key: { pk: `JOB#${jobId}`, sk: `APPLICATION#${applicationId}` },
    }));
    const appItem = appItemRes.Item || {};
    await ddb.send(new UpdateCommand({
      TableName: APPLICATIONS_TABLE,
      Key: { pk: `JOB#${jobId}`, sk: `APPLICATION#${applicationId}` },
      UpdateExpression: 'SET #st = :s, updatedAt = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':s': status, ':now': new Date().toISOString() },
    }));
    const NOTIFY_STATUSES = new Set(['shortlisted', 'human_interview', 'offered', 'rejected', 'withdrawn']);
    if (NOTIFY_STATUSES.has(status)) {
      notifyStatusChange(status, {
        applicationId, jobId,
        seekerId:       appItem.seekerId,
        recruiterId:    appItem.recruiterId || req.recruiterEmail,
        candidateName:  appItem.candidateName,
        candidateEmail: appItem.candidateEmail,
        jobTitle:       appItem.jobTitle || null,
      }).catch(() => {});
    }
    res.json({ applicationId, status });
}));

// ── GET /applications/:applicationId/report ────────────────────────────────────
router.get('/:applicationId/report', requireAuth, asyncHandler(async (req, res) => {
    const { applicationId } = req.params;
    const { jobId } = req.query;
    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ error: 'jobId query parameter is required' });
    }
    const appRes = await ddb.send(new GetCommand({
      TableName: APPLICATIONS_TABLE,
      Key: { pk: `JOB#${jobId}`, sk: `APPLICATION#${applicationId}` },
    }));
    if (!appRes.Item) return res.status(404).json({ error: 'Application not found' });
    const application = appRes.Item;

    const reportRes = await ddb.send(new QueryCommand({
      TableName: INTERVIEW_REPORTS_TABLE,
      IndexName: 'ReportByApplication',
      KeyConditionExpression: 'applicationId = :aid',
      ExpressionAttributeValues: { ':aid': applicationId },
      Limit: 1,
    }));
    const report = (reportRes.Items && reportRes.Items[0]) || null;

    let transcript = null;
    const interviewId = report ? report.interviewId : null;
    if (interviewId) {
      const histRes = await ddb.send(new GetCommand({
        TableName: SESSION_TABLE,
        Key: { pk: `INTERVIEW#${interviewId}`, sk: 'HISTORY' },
      }));
      transcript = histRes.Item ? (histRes.Item.history || null) : null;
    }
    res.json({ application, report, transcript });
}));

// ── GET /applications/:id/messages ────────────────────────────────────────────
router.get('/:id/messages', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.length > 100) return res.status(400).json({ error: 'Invalid id' });
    const result = await ddb.send(new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `APPLICATION#${id}` },
      ScanIndexForward: true,
    }));
    res.json({ messages: result.Items || [] });
}));

// ── POST /applications/:id/messages ───────────────────────────────────────────
router.post('/:id/messages', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { body: msgBody, jobId } = req.body;
    if (!id || typeof id !== 'string' || id.length > 100) return res.status(400).json({ error: 'Invalid id' });
    if (!msgBody || typeof msgBody !== 'string' || msgBody.trim().length === 0) return res.status(400).json({ error: 'Message body required' });
    if (msgBody.length > 3000) return res.status(400).json({ error: 'Message too long (max 3000 chars)' });
    const now   = new Date().toISOString();
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const message = {
      pk: `APPLICATION#${id}`,
      sk: `MSG#${now}#${msgId}`,
      messageId: msgId, applicationId: id,
      senderId: req.recruiterEmail, senderName: req.recruiterEmail.split('@')[0],
      senderRole: 'recruiter', body: msgBody.trim(), sentAt: now,
    };
    await ddb.send(new PutCommand({ TableName: MESSAGES_TABLE, Item: message }));

    if (jobId) {
      const appRes = await ddb.send(new GetCommand({
        TableName: APPLICATIONS_TABLE,
        Key: { pk: `JOB#${jobId}`, sk: `APPLICATION#${id}` },
      }));
      const appItem = appRes.Item || {};
      if (appItem.seekerId) {
        createNotification(appItem.seekerId, 'new_message', id, jobId,
          `New message from recruiter`,
          msgBody.trim().slice(0, 120) + (msgBody.length > 120 ? '…' : ''),
        ).catch(() => {});
      }
    }
    res.status(201).json({ message });
}));

export default router;
