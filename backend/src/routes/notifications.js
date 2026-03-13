// Notification routes for both recruiters and seekers.
// notificationsRouter     → mount at /notifications
// seekerNotificationsRouter → mount at /seeker/notifications

import { Router } from 'express';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, NOTIFICATIONS_TABLE } from '../utils/clients.js';
import { requireAuth, requireSeekerAuth } from '../utils/auth.js';

// ── Recruiter notifications ───────────────────────────────────────────────────
const notificationsRouter = Router();

notificationsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${req.recruiterEmail}` },
      ScanIndexForward: false,
      Limit: 50,
    }));
    res.json({ notifications: result.Items || [] });
  } catch (err) {
    console.error('GET /notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

notificationsRouter.post('/read-all', requireAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: '#r = :f',
      ExpressionAttributeNames: { '#r': 'read' },
      ExpressionAttributeValues: { ':pk': `USER#${req.recruiterEmail}`, ':f': false },
    }));
    await Promise.all((result.Items || []).map(n =>
      ddb.send(new UpdateCommand({
        TableName: NOTIFICATIONS_TABLE,
        Key: { pk: n.pk, sk: n.sk },
        UpdateExpression: 'SET #r = :t',
        ExpressionAttributeNames: { '#r': 'read' },
        ExpressionAttributeValues: { ':t': true },
      }))
    ));
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /notifications/read-all error:', err);
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

notificationsRouter.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await ddb.send(new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'notificationId = :nid',
      ExpressionAttributeValues: { ':pk': `USER#${req.recruiterEmail}`, ':nid': id },
      Limit: 1,
    }));
    const item = result.Items && result.Items[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    await ddb.send(new UpdateCommand({
      TableName: NOTIFICATIONS_TABLE,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: 'SET #r = :t',
      ExpressionAttributeNames: { '#r': 'read' },
      ExpressionAttributeValues: { ':t': true },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /notifications/:id/read error:', err);
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

// ── Seeker notifications ──────────────────────────────────────────────────────
export const seekerNotificationsRouter = Router();

seekerNotificationsRouter.get('/', requireSeekerAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${req.seekerId}` },
      ScanIndexForward: false,
      Limit: 50,
    }));
    res.json({ notifications: result.Items || [] });
  } catch (err) {
    console.error('GET /seeker/notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

seekerNotificationsRouter.post('/read-all', requireSeekerAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: '#r = :f',
      ExpressionAttributeNames: { '#r': 'read' },
      ExpressionAttributeValues: { ':pk': `USER#${req.seekerId}`, ':f': false },
    }));
    await Promise.all((result.Items || []).map(n =>
      ddb.send(new UpdateCommand({
        TableName: NOTIFICATIONS_TABLE,
        Key: { pk: n.pk, sk: n.sk },
        UpdateExpression: 'SET #r = :t',
        ExpressionAttributeNames: { '#r': 'read' },
        ExpressionAttributeValues: { ':t': true },
      }))
    ));
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /seeker/notifications/read-all error:', err);
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

seekerNotificationsRouter.post('/:id/read', requireSeekerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await ddb.send(new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'notificationId = :nid',
      ExpressionAttributeValues: { ':pk': `USER#${req.seekerId}`, ':nid': id },
      Limit: 1,
    }));
    const item = result.Items && result.Items[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    await ddb.send(new UpdateCommand({
      TableName: NOTIFICATIONS_TABLE,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression: 'SET #r = :t',
      ExpressionAttributeNames: { '#r': 'read' },
      ExpressionAttributeValues: { ':t': true },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /seeker/notifications/:id/read error:', err);
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

export default notificationsRouter;
