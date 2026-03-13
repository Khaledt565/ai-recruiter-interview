// Seeker application browsing, detail, withdraw, and messaging.
// Mounts at /seeker.

import { Router } from 'express';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, APPLICATIONS_TABLE, JOBS_TABLE, MESSAGES_TABLE, USERS_TABLE } from '../utils/clients.js';
import { requireSeekerAuth } from '../utils/auth.js';
import { createNotification, notifyStatusChange } from '../utils/notifications.js';

const router = Router();

// ── GET /seeker/applications ───────────────────────────────────────────────────
router.get('/applications', requireSeekerAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: APPLICATIONS_TABLE,
      IndexName: 'ApplicationsBySeeker',
      KeyConditionExpression: 'seekerId = :sid',
      ExpressionAttributeValues: { ':sid': req.seekerId },
      ScanIndexForward: false,
    }));
    const apps = (result.Items || []).map(a => ({
      applicationId:  a.applicationId,
      jobId:          a.jobId,
      candidateName:  a.candidateName,
      status:         a.status,
      aiProfileScore: a.aiProfileScore,
      recommended:    a.recommended,
      appliedAt:      a.appliedAt,
      updatedAt:      a.updatedAt,
    }));

    const jobIds = [...new Set(apps.map(a => a.jobId).filter(Boolean))];
    if (jobIds.length) {
      await Promise.all(jobIds.map(async jid => {
        try {
          const jr = await ddb.send(new QueryCommand({
            TableName: JOBS_TABLE,
            IndexName: 'JobsByJobId',
            KeyConditionExpression: 'jobId = :jid',
            ExpressionAttributeValues: { ':jid': jid },
            Limit: 1,
          }));
          const job = jr.Items && jr.Items[0];
          if (job) {
            apps.filter(a => a.jobId === jid).forEach(a => {
              a.jobTitle          = job.title;
              a.jobLocation       = job.location;
              a.jobEmploymentType = job.employmentType;
            });
          }
        } catch { /* skip enrichment on error */ }
      }));
    }

    res.json({ applications: apps });
  } catch (error) {
    console.error('Error fetching seeker applications:', error);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// ── GET /seeker/applications/:id ──────────────────────────────────────────────
router.get('/applications/:id', requireSeekerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.length > 100) {
      return res.status(400).json({ error: 'Invalid application ID' });
    }
    const result = await ddb.send(new QueryCommand({
      TableName: APPLICATIONS_TABLE,
      IndexName: 'ApplicationById',
      KeyConditionExpression: 'applicationId = :aid',
      ExpressionAttributeValues: { ':aid': id },
      Limit: 1,
    }));
    const app = result.Items && result.Items[0];
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.seekerId !== req.seekerId) return res.status(403).json({ error: 'Forbidden' });

    let job = null;
    try {
      const jr = await ddb.send(new QueryCommand({
        TableName: JOBS_TABLE,
        IndexName: 'JobsByJobId',
        KeyConditionExpression: 'jobId = :jid',
        ExpressionAttributeValues: { ':jid': app.jobId },
        Limit: 1,
      }));
      job = jr.Items && jr.Items[0];
    } catch { /* skip enrichment */ }

    res.json({
      applicationId:      app.applicationId,
      jobId:              app.jobId,
      jobTitle:           job ? job.title : null,
      jobLocation:        job ? job.location : null,
      jobEmploymentType:  job ? job.employmentType : null,
      candidateName:      app.candidateName,
      status:             app.status,
      aiProfileScore:     app.aiProfileScore,
      aiProfileReasoning: app.aiProfileReasoning,
      recommended:        app.recommended,
      coverLetter:        app.coverLetter,
      appliedAt:          app.appliedAt,
      updatedAt:          app.updatedAt,
    });
  } catch (error) {
    console.error('Error fetching seeker application detail:', error);
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

// ── POST /seeker/applications/:id/withdraw ────────────────────────────────────
router.post('/applications/:id/withdraw', requireSeekerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const appResult = await ddb.send(new QueryCommand({
      TableName: APPLICATIONS_TABLE,
      IndexName: 'ApplicationById',
      KeyConditionExpression: 'applicationId = :aid',
      ExpressionAttributeValues: { ':aid': id },
      Limit: 1,
    }));
    const app = appResult.Items && appResult.Items[0];
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.seekerId !== req.seekerId) return res.status(403).json({ error: 'Forbidden' });
    const now = new Date().toISOString();
    await ddb.send(new UpdateCommand({
      TableName: APPLICATIONS_TABLE,
      Key: { pk: app.pk, sk: app.sk },
      UpdateExpression: 'SET #st = :s, updatedAt = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':s': 'withdrawn', ':now': now },
    }));
    notifyStatusChange('withdrawn', {
      applicationId: id, jobId: app.jobId,
      seekerId: app.seekerId, recruiterId: app.recruiterId,
      candidateName: app.candidateName, candidateEmail: app.candidateEmail,
      jobTitle: app.jobTitle || null,
    }).catch(() => {});
    res.json({ applicationId: id, status: 'withdrawn' });
  } catch (err) {
    console.error('POST /seeker/applications/:id/withdraw error:', err);
    res.status(500).json({ error: 'Failed to withdraw application' });
  }
});

// ── GET /seeker/applications/:id/messages ─────────────────────────────────────
router.get('/applications/:id/messages', requireSeekerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.length > 100) return res.status(400).json({ error: 'Invalid id' });
    const appResult = await ddb.send(new QueryCommand({
      TableName: APPLICATIONS_TABLE,
      IndexName: 'ApplicationById',
      KeyConditionExpression: 'applicationId = :aid',
      ExpressionAttributeValues: { ':aid': id },
      Limit: 1,
    }));
    const app = appResult.Items && appResult.Items[0];
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.seekerId !== req.seekerId) return res.status(403).json({ error: 'Forbidden' });
    const result = await ddb.send(new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `APPLICATION#${id}` },
      ScanIndexForward: true,
    }));
    res.json({ messages: result.Items || [] });
  } catch (err) {
    console.error('GET /seeker/applications/:id/messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ── POST /seeker/applications/:id/messages ────────────────────────────────────
router.post('/applications/:id/messages', requireSeekerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { body: msgBody } = req.body;
    if (!id || typeof id !== 'string' || id.length > 100) return res.status(400).json({ error: 'Invalid id' });
    if (!msgBody || typeof msgBody !== 'string' || msgBody.trim().length === 0) return res.status(400).json({ error: 'Message body required' });
    if (msgBody.length > 3000) return res.status(400).json({ error: 'Message too long (max 3000 chars)' });

    const appResult = await ddb.send(new QueryCommand({
      TableName: APPLICATIONS_TABLE,
      IndexName: 'ApplicationById',
      KeyConditionExpression: 'applicationId = :aid',
      ExpressionAttributeValues: { ':aid': id },
      Limit: 1,
    }));
    const app = appResult.Items && appResult.Items[0];
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.seekerId !== req.seekerId) return res.status(403).json({ error: 'Forbidden' });

    const profile = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { pk: `USER#${req.seekerId}`, sk: 'PROFILE' },
    }));
    const senderName = (profile.Item && profile.Item.fullName) || req.seekerEmail.split('@')[0];

    const now   = new Date().toISOString();
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const message = {
      pk: `APPLICATION#${id}`,
      sk: `MSG#${now}#${msgId}`,
      messageId: msgId, applicationId: id,
      senderId: req.seekerId, senderName,
      senderRole: 'seeker', body: msgBody.trim(), sentAt: now,
    };
    await ddb.send(new PutCommand({ TableName: MESSAGES_TABLE, Item: message }));

    if (app.recruiterId) {
      createNotification(app.recruiterId, 'new_message', id, app.jobId,
        `New message from ${senderName}`,
        msgBody.trim().slice(0, 120) + (msgBody.length > 120 ? '...' : ''),
      ).catch(() => {});
    }
    res.status(201).json({ message });
  } catch (err) {
    console.error('POST /seeker/applications/:id/messages error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

export default router;
