// Notification routes for both recruiters and seekers.
// notificationsRouter     → mount at /notifications
// seekerNotificationsRouter → mount at /seeker/notifications

import { Router } from 'express';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, NOTIFICATIONS_TABLE } from '../utils/clients.js';
import { requireAuth, requireSeekerAuth } from '../utils/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

// ── Recruiter notifications ───────────────────────────────────────────────────
const notificationsRouter = Router();

notificationsRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
    const result = await ddb.send(new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${req.recruiterEmail}` },
      ScanIndexForward: false,
      Limit: 50,
    }));
    res.json({ notifications: result.Items || [] });
}));

notificationsRouter.post('/read-all', requireAuth, asyncHandler(async (req, res) => {
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
}));

notificationsRouter.post('/:id/read', requireAuth, asyncHandler(async (req, res) => {
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
}));

// ── Seeker notifications ──────────────────────────────────────────────────────
export const seekerNotificationsRouter = Router();

seekerNotificationsRouter.get('/', requireSeekerAuth, asyncHandler(async (req, res) => {
    const result = await ddb.send(new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${req.seekerId}` },
      ScanIndexForward: false,
      Limit: 50,
    }));
    res.json({ notifications: result.Items || [] });
}));

seekerNotificationsRouter.post('/read-all', requireSeekerAuth, asyncHandler(async (req, res) => {
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
}));

seekerNotificationsRouter.post('/:id/read', requireSeekerAuth, asyncHandler(async (req, res) => {
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
}));

export default notificationsRouter;
