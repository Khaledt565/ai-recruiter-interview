// Seeker profile routes (GET/PUT /seeker/profile, POST /seeker/profile/cv).
// Mounts at /seeker.

import { Router } from 'express';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ddb, s3, USERS_TABLE, S3_CV_BUCKET, REGION } from '../utils/clients.js';
import { requireSeekerAuth } from '../utils/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// ── GET /seeker/profile ───────────────────────────────────────────────────────
router.get('/profile', requireSeekerAuth, asyncHandler(async (req, res) => {
    const result = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { pk: `USER#${req.seekerId}`, sk: 'PROFILE' },
    }));
    if (!result.Item) return res.status(404).json({ error: 'Profile not found' });
    const u = result.Item;
    res.json({
      userId:          u.userId,
      email:           u.email,
      fullName:        u.fullName,
      location:        u.location,
      skills:          u.skills || [],
      availability:    u.availability,
      bio:             u.bio,
      cvUrl:           u.cvUrl,
      profileComplete: u.profileComplete || 0,
      createdAt:       u.createdAt,
    });
}));

// ── PUT /seeker/profile ───────────────────────────────────────────────────────
router.put('/profile', requireSeekerAuth, asyncHandler(async (req, res) => {
    const { fullName, location, skills, availability, bio } = req.body;
    const validAvailabilities = ['immediately', '2_weeks', '1_month', '3_months', 'not_looking'];

    const cleanName   = fullName     ? String(fullName).trim()   : null;
    const cleanLoc    = location     ? String(location).trim()   : null;
    const cleanSkills = Array.isArray(skills)
      ? skills.map(s => String(s).trim()).filter(Boolean).slice(0, 30)
      : null;
    const cleanAvail = validAvailabilities.includes(availability) ? availability : null;
    const cleanBio   = bio ? String(bio).trim().substring(0, 2000) : null;

    const existing = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { pk: `USER#${req.seekerId}`, sk: 'PROFILE' },
    }));
    if (!existing.Item) return res.status(404).json({ error: 'Profile not found' });

    const merged = { ...existing.Item };
    if (cleanName   !== null) merged.fullName     = cleanName;
    if (cleanLoc    !== null) merged.location     = cleanLoc;
    if (cleanSkills !== null) merged.skills       = cleanSkills;
    if (cleanAvail  !== null) merged.availability = cleanAvail;
    if (cleanBio    !== null) merged.bio          = cleanBio;
    merged.updatedAt = new Date().toISOString();

    let score = 20;
    if (merged.fullName)                        score += 15;
    if (merged.location)                        score += 15;
    if (merged.skills && merged.skills.length)  score += 15;
    if (merged.availability)                    score += 10;
    if (merged.bio)                             score += 10;
    if (merged.cvUrl)                           score += 15;
    merged.profileComplete = Math.min(100, score);

    await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: merged }));
    res.json({ profileComplete: merged.profileComplete });
}));

// ── POST /seeker/profile/cv ───────────────────────────────────────────────────
router.post('/profile/cv', requireSeekerAuth, asyncHandler(async (req, res) => {
    const { base64, mimeType, filename } = req.body;
    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({ error: 'base64 file data is required' });
    }
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    const safeMime = allowedTypes.includes(mimeType) ? mimeType : 'application/pdf';

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.byteLength > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'CV file must be under 10MB' });
    }

    const ext   = safeMime === 'application/pdf' ? 'pdf' : safeMime === 'application/msword' ? 'doc' : 'docx';
    const s3Key = `cvs/${req.seekerId}/${Date.now()}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_CV_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: safeMime,
      ServerSideEncryption: 'AES256',
    }));

    const cvUrl = `https://${S3_CV_BUCKET}.s3.${REGION}.amazonaws.com/${s3Key}`;

    const existing = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { pk: `USER#${req.seekerId}`, sk: 'PROFILE' },
    }));
    if (existing.Item) {
      const merged = { ...existing.Item, cvS3Key: s3Key, cvUrl, updatedAt: new Date().toISOString() };
      let score = 20;
      if (merged.fullName)                        score += 15;
      if (merged.location)                        score += 15;
      if (merged.skills && merged.skills.length)  score += 15;
      if (merged.availability)                    score += 10;
      if (merged.bio)                             score += 10;
      if (merged.cvUrl)                           score += 15;
      merged.profileComplete = Math.min(100, score);
      await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: merged }));
    }

    res.json({ cvUrl, s3Key });
}));

export default router;
