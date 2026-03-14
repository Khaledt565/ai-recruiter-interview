// Auth middleware, JWT helpers, password hashing, rate limiters.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import rateLimit from 'express-rate-limit';
import { REGION, COGNITO_USER_POOL_ID, SEEKER_JWT_SECRET, LINK_SECRET } from './clients.js';

// ── HMAC link token (interview invite links) ──────────────────────────────────
export function generateLinkToken(interviewId) {
  return crypto.createHmac('sha256', LINK_SECRET).update(interviewId).digest('hex');
}

export function verifyLinkToken(interviewId, token) {
  const expected = generateLinkToken(interviewId);
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ── Cognito JWT verification (recruiter) ─────────────────────────────────────
const jwks = jwksClient({
  jwksUri: `https://cognito-idp.${REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000, // 10 min
});

function getSigningKey(header, callback) {
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  jwt.verify(token, getSigningKey, { algorithms: ['RS256'] }, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    req.recruiterEmail = decoded.email || decoded['cognito:username'];
    next();
  });
}

// ── Custom seeker JWT verification ───────────────────────────────────────────
export function requireSeekerAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, SEEKER_JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.role !== 'seeker') return res.status(403).json({ error: 'Forbidden' });
    req.seekerId = decoded.sub;
    req.seekerEmail = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Password hashing (Node crypto — no external dependency) ──────────────────
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

// ── Dual-mode auth (accepts either a recruiter Cognito token or a seeker JWT) ─
// Sets req.recruiterEmail (Cognito) or req.seekerId + req.seekerEmail (seeker).
export function requireAnyAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  // Try seeker HS256 first (synchronous fast path)
  try {
    const decoded = jwt.verify(token, SEEKER_JWT_SECRET, { algorithms: ['HS256'] }); // pragma: allowlist secret
    if (decoded.role === 'seeker') {
      req.seekerId    = decoded.sub;
      req.seekerEmail = decoded.email;
      return next();
    }
  } catch { /* not a seeker token — fall through to Cognito */ }

  // Fall back to Cognito RS256 (asynchronous)
  jwt.verify(token, getSigningKey, { algorithms: ['RS256'] }, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    req.recruiterEmail = decoded.email || decoded['cognito:username'];
    next();
  });
}

// ── Rate limiter for seeker auth endpoints ────────────────────────────────────
export const seekerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
});
