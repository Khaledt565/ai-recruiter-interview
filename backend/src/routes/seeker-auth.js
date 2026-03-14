// Seeker authentication routes (signup, login, forgot/reset password).
// Mounts at /seeker/auth.

import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { SendEmailCommand } from '@aws-sdk/client-ses';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ses, USERS_TABLE, SEEKER_JWT_SECRET, SES_FROM_EMAIL, FRONTEND_URL } from '../utils/clients.js';
import { ddbSend } from '../utils/aws-wrappers.js';
import { seekerAuthLimiter, hashPassword, verifyPassword } from '../utils/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// ── POST /seeker/auth/signup ──────────────────────────────────────────────────
router.post('/signup', seekerAuthLimiter, asyncHandler(async (req, res) => {
    const { email, password, fullName } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) { // pragma: allowlist secret
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    const normalEmail = email.toLowerCase().trim();

    const existing = await ddbSend(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'UsersByEmail',
      KeyConditionExpression: 'email = :em',
      ExpressionAttributeValues: { ':em': normalEmail },
      Limit: 1,
    }));
    if (existing.Items && existing.Items.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const userId = `user_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    const now    = new Date().toISOString();
    await ddbSend(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        pk: `USER#${userId}`,
        sk: 'PROFILE',
        userId,
        email: normalEmail,
        passwordHash: hashPassword(password),
        role: 'seeker',
        fullName: fullName.trim(),
        location: null,
        skills: [],
        availability: null,
        bio: null,
        cvS3Key: null,
        cvUrl: null,
        profileComplete: 20,
        createdAt: now,
        updatedAt: now,
      },
    }));

    const token = jwt.sign(
      { sub: userId, email: normalEmail, role: 'seeker' },
      SEEKER_JWT_SECRET, // pragma: allowlist secret
      { algorithm: 'HS256', expiresIn: '7d' },
    );
    console.log(`[Seeker] Signup: ${normalEmail} (${userId})`);
    res.status(201).json({ token, userId, email: normalEmail, fullName: fullName.trim() });
}));

// ── POST /seeker/auth/login ───────────────────────────────────────────────────
router.post('/login', seekerAuthLimiter, asyncHandler(async (req, res) => {
    const { email, password } = req.body; // pragma: allowlist secret
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const normalEmail = email.toLowerCase().trim();
    const result = await ddbSend(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'UsersByEmail',
      KeyConditionExpression: 'email = :em',
      ExpressionAttributeValues: { ':em': normalEmail },
      Limit: 1,
    }));
    const user = result.Items && result.Items[0];
    if (!user || !verifyPassword(password, user.passwordHash || '')) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign(
      { sub: user.userId, email: normalEmail, role: 'seeker' },
        SEEKER_JWT_SECRET, // pragma: allowlist secret
      { algorithm: 'HS256', expiresIn: '7d' },
    );
    res.json({
      token,
      userId:          user.userId,
      email:           normalEmail,
      fullName:        user.fullName || '',
      profileComplete: user.profileComplete || 0,
    });
}));

// ── POST /seeker/auth/forgot-password ─────────────────────────────────────────
router.post('/forgot-password', seekerAuthLimiter, asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    const normalEmail = email.toLowerCase().trim();

    const result = await ddbSend(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'UsersByEmail',
      KeyConditionExpression: 'email = :em',
      ExpressionAttributeValues: { ':em': normalEmail },
      Limit: 1,
    }));
    const user = result.Items && result.Items[0];
    if (!user) {
      return res.json({ message: 'If that email is registered, a reset link has been sent.' });
    }

    const resetToken  = crypto.randomBytes(32).toString('hex');
    const resetExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await ddbSend(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { pk: `USER#${user.userId}`, sk: 'PROFILE' },
      UpdateExpression: 'SET resetToken = :t, resetExpiry = :e',
      ExpressionAttributeValues: { ':t': resetToken, ':e': resetExpiry },
    }));

    if (SES_FROM_EMAIL) {
      const resetLink = `${FRONTEND_URL}/seeker-reset-password.html?token=${resetToken}&email=${encodeURIComponent(normalEmail)}`;
      await ses.send(new SendEmailCommand({
        Source: SES_FROM_EMAIL,
        Destination: { ToAddresses: [normalEmail] },
        Message: {
          Subject: { Data: 'Reset your TalentAI password' },
          Body: {
            Html: {
              Data: `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
                  <h2 style="margin:0 0 8px;font-size:22px;">Reset your password</h2>
                  <p style="color:#6b7280;margin:0 0 24px;">Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
                  <a href="${resetLink}" style="display:inline-block;padding:13px 28px;background:#6366f1;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">Reset password</a>
                  <p style="color:#9ca3af;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
                  <p style="color:#9ca3af;font-size:12px;">Or copy this link: ${resetLink}</p>
                </div>`,
            },
          },
        },
      }));
    }

    res.json({ message: 'If that email is registered, a reset link has been sent.' });
}));

// ── POST /seeker/auth/reset-password ──────────────────────────────────────────
router.post('/reset-password', seekerAuthLimiter, asyncHandler(async (req, res) => {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'email, token, and newPassword are required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) { // pragma: allowlist secret
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const normalEmail = email.toLowerCase().trim();

    const result = await ddbSend(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'UsersByEmail',
      KeyConditionExpression: 'email = :em',
      ExpressionAttributeValues: { ':em': normalEmail },
      Limit: 1,
    }));
    const user = result.Items && result.Items[0];

    if (!user || user.resetToken !== token) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }
    if (!user.resetExpiry || new Date() > new Date(user.resetExpiry)) {
      return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    }

    await ddbSend(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { pk: `USER#${user.userId}`, sk: 'PROFILE' },
      UpdateExpression: 'SET passwordHash = :h, updatedAt = :u REMOVE resetToken, resetExpiry',
      ExpressionAttributeValues: {
        ':h': hashPassword(newPassword),
        ':u': new Date().toISOString(),
      },
    }));

    console.log(`[Seeker] Password reset for ${normalEmail}`);
    res.json({ message: 'Password updated successfully' });
}));

export default router;
