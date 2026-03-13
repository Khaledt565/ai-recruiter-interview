// backend/src/server.js
// Fargate Express server with WebSocket support + Interview Link Generation

import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { processTranscript, generateCandidateSummary } from './interview-engine.js';
import { suggestQuestionsFromCV, scoreProfileWithAI, generateInterviewReport } from './bedrock-client.js';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 8080;
const REGION = process.env.AWS_REGION || 'eu-central-1';
const SESSION_TABLE           = process.env.SESSION_TABLE            || 'InterviewSessions';
const JOBS_TABLE              = process.env.JOBS_TABLE               || 'Jobs-dev';
const APPLICATIONS_TABLE      = process.env.APPLICATIONS_TABLE       || 'Applications-dev';
const AI_SESSIONS_TABLE       = process.env.AI_SESSIONS_TABLE        || 'AIInterviewSessions-dev';
const QUESTION_TEMPLATES_TABLE = process.env.QUESTION_TEMPLATES_TABLE || 'QuestionTemplates-dev';
const INTERVIEW_REPORTS_TABLE  = process.env.INTERVIEW_REPORTS_TABLE  || 'InterviewReports-dev';
const COGNITO_USER_POOL_ID    = process.env.COGNITO_USER_POOL_ID     || 'eu-central-1_JbO8lhpi2';
const USERS_TABLE             = process.env.USERS_TABLE              || 'Users-dev';
const S3_CV_BUCKET            = process.env.S3_CV_BUCKET             || 'ai-recruiter-interviews-090605004529';
const SEEKER_JWT_SECRET       = process.env.SEEKER_JWT_SECRET        || 'seeker-dev-secret-change-in-prod';
const NOTIFICATIONS_TABLE     = process.env.NOTIFICATIONS_TABLE      || 'Notifications-dev';
const MESSAGES_TABLE          = process.env.MESSAGES_TABLE           || 'Messages-dev';

const polly = new PollyClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const ses = new SESClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || '';
const LINK_SECRET = process.env.LINK_SECRET || 'default-dev-secret-change-in-prod';

function generateLinkToken(interviewId) {
  return crypto.createHmac('sha256', LINK_SECRET).update(interviewId).digest('hex');
}

function verifyLinkToken(interviewId, token) {
  const expected = generateLinkToken(interviewId);
  try {
    return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// JWT verification using Cognito JWKS
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

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  jwt.verify(token, getSigningKey, { algorithms: ['RS256'] }, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    req.recruiterEmail = decoded.email || decoded['cognito:username'];
    next();
  });
}

function requireSeekerAuth(req, res, next) {
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

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Save full interview conversation to S3 (called on completion, disconnection, or explicit end)
async function saveInterviewSnapshot(meetingId, attendeeId, status) {
  try {
    const [stateRes, metaRes] = await Promise.all([
      ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `MEETING#${meetingId}`, sk: `ATTENDEE#${attendeeId}` } })),
      ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${meetingId}`, sk: `META` } })),
    ]);
    const state = stateRes.Item || {};
    const meta = metaRes.Item || {};

    // Generate AI summary for non-pipeline interviews (pipeline interviews use finalizeInterviewPipeline)
    let aiSummary = null;
    if (status === 'completed' && !meta.applicationId && state.history && state.history.length > 0) {
      try {
        aiSummary = await generateCandidateSummary(
          state.history,
          meta.candidateName || 'Unknown',
          state.jobDescription || meta.jobDescription || null,
        );
        console.log(`âœ… AI summary generated for ${meetingId}: ${aiSummary?.recommendation} (${aiSummary?.score}/10)`);
      } catch (err) {
        console.error('âŒ Failed to generate AI summary:', err);
      }
    }

    const snapshot = {
      interviewId: meetingId,
      candidateName: meta.candidateName || 'Unknown',
      candidateEmail: meta.candidateEmail || '',
      recruiterEmail: meta.recruiterEmail || '',
      status,
      savedAt: new Date().toISOString(),
      startedAt: state.startedAt || null,
      createdAt: meta.createdAt || null,
      questionsAnswered: state.qIndex || 0,
      totalQuestions: (state.questions || []).length,
      completed: state.done || false,
      jobDescription: state.jobDescription || meta.jobDescription || null,
      aiSummary,
      conversation: (state.history || []).map((h, i) => ({
        turn: i + 1,
        question: h.q,
        candidateAnswer: h.a,
        aiReply: h.reply,
        timestamp: h.t,
      })),
    };

    await s3.send(new PutObjectCommand({
      Bucket: 'ai-recruiter-interviews-090605004529',
      Key: `interviews/${meetingId}/${status}-${Date.now()}.json`,
      Body: JSON.stringify(snapshot, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));

    // Build DynamoDB update expression â€” optionally store AI summary fields
    let updateExpr = 'SET #st = :status, updatedAt = :now';
    const exprNames = { '#st': 'status' };
    const exprValues = { ':status': status, ':now': new Date().toISOString() };
    if (aiSummary) {
      updateExpr += ', aiScore = :score, aiRecommendation = :rec, aiSummary = :summary';
      exprValues[':score'] = aiSummary.score;
      exprValues[':rec'] = aiSummary.recommendation;
      exprValues[':summary'] = aiSummary.summary;
    }

    await ddb.send(new UpdateCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${meetingId}`, sk: `META` },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }));

    // Notify recruiter / finalize pipeline when interview completes
    if (status === 'completed') {
      if (meta.applicationId) {
        // Pipeline interview: score answers, write report, update application, notify recruiter
        finalizeInterviewPipeline(meetingId, meta, state.history || [], state.jobDescription || meta.jobDescription || null)
          .catch(err => console.error('❌ Pipeline finalization failed:', err.message));
      } else if (meta.recruiterEmail && SES_FROM_EMAIL) {
        await sendRecruiterEmail(meta.recruiterEmail, meta.candidateName, aiSummary, meetingId);
      }
    }

    console.log(`âœ… Interview snapshot saved (${meetingId}, status: ${status}, turns: ${snapshot.conversation.length})`);
  } catch (err) {
    console.error('âŒ Failed to save interview snapshot:', err);
  }
}

async function sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink) {
  if (!SES_FROM_EMAIL) return;
  try {
    const htmlBody = `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f6fa;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#6366f1,#a855f7);padding:32px 36px 24px;">
      <div style="font-size:28px;margin-bottom:8px;">&#127919;</div>
      <h1 style="color:#fff;font-size:22px;margin:0 0 4px;">You've been invited to an AI Interview</h1>
      <p style="color:rgba(255,255,255,0.8);font-size:14px;margin:0;">Hello ${candidateName}, a recruiter has set up an AI-powered interview for you.</p>
    </div>
    <div style="padding:28px 36px;">
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 20px;">Click the button below to begin your interview. The AI interviewer will guide you through a series of questions â€” just speak naturally into your microphone.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${interviewLink}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:16px 36px;border-radius:10px;letter-spacing:0.01em;">&#128279; Click Here to Join Your Interview</a>
      </div>
      <p style="text-align:center;color:#6b7280;font-size:13px;margin:0 0 20px;">or copy and paste the link below into your browser</p>
      <div style="background:#f9fafb;border-radius:10px;padding:16px 18px;margin:20px 0;">
        <p style="font-size:12px;color:#6b7280;margin:0 0 6px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Or copy this link</p>
        <p style="font-size:12px;color:#6366f1;word-break:break-all;margin:0;font-family:monospace;">${interviewLink}</p>
      </div>
      <ul style="color:#6b7280;font-size:13px;line-height:1.8;padding-left:18px;margin:0;">
        <li>Find a quiet space with a good microphone</li>
        <li>This link is valid for 7 days and can only be used once</li>
        <li>Allow microphone access when prompted by your browser</li>
      </ul>
    </div>
    <div style="background:#f9fafb;padding:16px 36px;border-top:1px solid #e5e7eb;">
      <p style="color:#9ca3af;font-size:12px;margin:0;text-align:center;">Sent by AI Interviewer &mdash; do not reply to this email</p>
    </div>
  </div>
</body></html>`;

    await ses.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [candidateEmail] },
      Message: {
        Subject: { Data: `Your AI Interview is Ready â€” ${candidateName}` },
        Body: {
          Html: { Data: htmlBody },
          Text: { Data: `Hello ${candidateName},\n\nYou have been invited to an AI-powered interview.\n\nClick this link to begin:\n${interviewLink}\n\nThe link is valid for 7 days and can only be used once.\n\nGood luck!` },
        },
      },
    }));
    console.log(`âœ… Invitation email sent to ${candidateEmail}`);
  } catch (err) {
    console.error('âŒ Failed to send invitation email (non-fatal):', err.message);
  }
}

async function sendRecruiterEmail(recruiterEmail, candidateName, summary, interviewId) {
  try {
    const rec = summary?.recommendation || 'N/A';
    const score = summary?.score != null ? `${summary.score}/10` : 'N/A';
    const summaryText = summary?.summary || 'No summary available.';
    const strengths = (summary?.strengths || []).map(s => `  â€¢ ${s}`).join('\n');
    const concerns = (summary?.concerns || []).map(c => `  â€¢ ${c}`).join('\n');

    const bodyLines = [
      `Interview completed: ${candidateName}`,
      `Interview ID: ${interviewId}`,
      ``,
      `Recommendation: ${rec}`,
      `Score: ${score}`,
      ``,
      `Summary:`,
      summaryText,
    ];
    if (strengths) bodyLines.push(``, `Strengths:`, strengths);
    if (concerns) bodyLines.push(``, `Concerns:`, concerns);
    bodyLines.push(``, `View full transcript in your recruiter dashboard.`);

    await ses.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [recruiterEmail] },
      Message: {
        Subject: { Data: `Interview Complete: ${candidateName} â€” ${rec}` },
        Body: { Text: { Data: bodyLines.join('\n') } },
      },
    }));
    console.log(`âœ… Recruiter email sent to ${recruiterEmail}`);
  } catch (err) {
    console.error('âŒ Failed to send recruiter email (non-fatal):', err.message);
  }
}

// â”€â”€ Low-score recruiter notification email â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendRecruiterLowScoreEmail(recruiterEmail, candidateName, jobTitle, score, applicationId) {
  if (!SES_FROM_EMAIL || !recruiterEmail) return;
  try {
    await ses.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [recruiterEmail] },
      Message: {
        Subject: { Data: `New Application: ${candidateName} â€” ${score}/100 (below threshold)` },
        Body: {
          Text: {
            Data: [
              `A new application has arrived for: ${jobTitle}`,
              ``,
              `Candidate:      ${candidateName}`,
              `AI Profile Score: ${score}/100`,
              `Application ID: ${applicationId}`,
              ``,
              `This candidate scored below your threshold and has NOT been automatically invited to interview.`,
              `You can manually review and invite them from your recruiter dashboard.`,
            ].join('\n'),
          },
        },
      },
    }));
    console.log(`âœ… Low-score recruiter notification sent to ${recruiterEmail}`);
  } catch (err) {
    console.error('âŒ Failed to send low-score notification (non-fatal):', err.message);
  }
}

// ── Interview complete recruiter notification ─────────────────────────────────
async function sendInterviewCompleteNotification(recruiterEmail, candidateName, jobTitle, combinedScore, interviewId) {
  if (!SES_FROM_EMAIL || !recruiterEmail) return;
  try {
    await ses.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [recruiterEmail] },
      Message: {
        Subject: { Data: `Interview complete — ${candidateName} scored ${combinedScore}% for ${jobTitle}` },
        Body: {
          Text: {
            Data: [
              `Interview complete for: ${jobTitle}`,
              ``,
              `Candidate:     ${candidateName}`,
              `Combined Score: ${combinedScore}/100`,
              ``,
              `View the full report and scorecard in your recruiter dashboard.`,
              `Interview ID: ${interviewId}`,
            ].join('\n'),
          },
        },
      },
    }));
    console.log(`✅ Interview complete notification sent to ${recruiterEmail}`);
  } catch (err) {
    console.error('❌ Failed to send interview complete notification (non-fatal):', err.message);
  }
}

// ── Post-interview pipeline: score, report, application update ────────────────
async function finalizeInterviewPipeline(interviewId, meta, history, jobDescription) {
  const tag = `[Pipeline:${interviewId}]`;
  try {
    // 1. Generate per-answer scores and overall report via AI
    const report = await generateInterviewReport(
      history,
      meta.candidateName || 'Unknown',
      jobDescription,
    );

    // 2. Load Application record for aiProfileScore
    const appKey = { pk: `JOB#${meta.jobId}`, sk: `APPLICATION#${meta.applicationId}` };
    const appRes = await ddb.send(new GetCommand({ TableName: APPLICATIONS_TABLE, Key: appKey }));
    const app = appRes.Item || {};
    const aiProfileScore = typeof app.aiProfileScore === 'number' ? app.aiProfileScore : 0;

    // 3. Calculate combined score and auto-recommendation
    const aiInterviewScore = report.aiInterviewScore;
    const combinedScore = Math.round((aiProfileScore * 0.4) + (aiInterviewScore * 0.6));
    const recommendationThreshold = typeof meta.recommendationThreshold === 'number' ? meta.recommendationThreshold : 75;
    const autoRecommended = combinedScore >= recommendationThreshold;
    const jobTitle = meta.jobTitle || 'the role';

    console.log(`${tag} combinedScore: ${combinedScore} (profile ${aiProfileScore}×0.4 + interview ${aiInterviewScore}×0.6), autoRecommended: ${autoRecommended}`);

    // 4. Write InterviewReport record
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: INTERVIEW_REPORTS_TABLE,
      Item: {
        pk: `SESSION#${interviewId}`,
        sk: 'REPORT',
        sessionId: interviewId,
        applicationId: meta.applicationId,
        overallScore: combinedScore,
        aiInterviewScore,
        aiProfileScore,
        answerScores: report.answerScores,
        summary: report.summary,
        strengths: report.strengths,
        concerns: report.concerns,
        autoRecommended,
        generatedAt: now,
      },
    }));

    // 5. Update Application record: scores, recommended flag, status
    await ddb.send(new UpdateCommand({
      TableName: APPLICATIONS_TABLE,
      Key: appKey,
      UpdateExpression: 'SET aiInterviewScore = :iScore, combinedScore = :cScore, recommended = :rec, #st = :st, updatedAt = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':iScore': aiInterviewScore,
        ':cScore': combinedScore,
        ':rec': autoRecommended,
        ':st': autoRecommended ? 'recommended' : 'ai_interview_complete',
        ':now': now,
      },
    }));

    // 6. Send recruiter notification
    const recruiterEmail = meta.recruiterEmail || app.recruiterId || '';
    await sendInterviewCompleteNotification(recruiterEmail, meta.candidateName, jobTitle, combinedScore, interviewId);

    // 7. In-app notification for recruiter
    const notifType  = autoRecommended ? 'recommended' : 'ai_interview_complete';
    const notifTitle = autoRecommended
      ? `⭐ Recommended – ${meta.candidateName || 'Candidate'}`
      : `Interview complete – ${meta.candidateName || 'Candidate'}`;
    const notifBody  = autoRecommended
      ? `${meta.candidateName} is AI-recommended for ${jobTitle} (score: ${combinedScore}%)`
      : `${meta.candidateName} completed their AI interview for ${jobTitle} (score: ${combinedScore}%)`;
    createNotification(recruiterEmail, notifType, meta.applicationId, meta.jobId, notifTitle, notifBody).catch(() => {});

    console.log(`✅ ${tag} Pipeline finalized — status: ${autoRecommended ? 'recommended' : 'ai_interview_complete'}`);
  } catch (err) {
    console.error(`❌ ${tag} Pipeline finalization failed:`, err.message);
    throw err;
  }
}

// ── Notification helpers ────────────────────────────────────────────────────
async function createNotification(userId, type, applicationId, jobId, title, body) {
  try {
    if (!userId) return;
    const now     = new Date().toISOString();
    const notifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    await ddb.send(new PutCommand({
      TableName: NOTIFICATIONS_TABLE,
      Item: {
        pk:             `USER#${userId}`,
        sk:             `NOTIF#${now}#${notifId}`,
        notificationId: notifId,
        userId,
        applicationId:  applicationId || null,
        jobId:          jobId || null,
        type,
        title,
        body:           body || '',
        read:           false,
        createdAt:      now,
      },
    }));
  } catch (e) {
    console.error('createNotification error:', e.message);
  }
}

async function notifyStatusChange(newStatus, app) {
  const { applicationId, jobId, seekerId, recruiterId, candidateName, candidateEmail } = app;
  // Fetch job title if not provided
  let jobTitle = app.jobTitle || null;
  if (!jobTitle && jobId) {
    try {
      const jr = await ddb.send(new QueryCommand({
        TableName: JOBS_TABLE,
        IndexName: 'JobsByJobId',
        KeyConditionExpression: 'jobId = :jid',
        ExpressionAttributeValues: { ':jid': jobId },
        Limit: 1,
      }));
      jobTitle = (jr.Items && jr.Items[0] && jr.Items[0].title) || null;
    } catch { /* ignore */ }
  }
  const jt = jobTitle || 'a role';

  const NOTIF_MAP = {
    shortlisted: {
      userId: seekerId, sesTo: candidateEmail,
      title: `You've been shortlisted – ${jt}`,
      body:  `Congratulations! You are shortlisted for ${jt}`,
      sesSubject: `Great news – you've been shortlisted for ${jt}`,
      sesBody: `Congratulations! You have been shortlisted for the position: ${jt}.\n\nYour recruiter will be in touch with next steps.`,
    },
    human_interview: {
      userId: seekerId, sesTo: candidateEmail,
      title: `Human interview – ${jt}`,
      body:  `You have been invited to a human interview for ${jt}`,
      sesSubject: `Human Interview Invitation – ${jt}`,
      sesBody: `You have progressed to a human interview for the position: ${jt}.\n\nYour recruiter will contact you with scheduling details.`,
    },
    offered: {
      userId: seekerId, sesTo: candidateEmail,
      title: `🎉 Job offer – ${jt}`,
      body:  `You have received a job offer for ${jt}`,
      sesSubject: `Job Offer – ${jt}`,
      sesBody: `Congratulations! You have received a job offer for the position: ${jt}.\n\nPlease log in to your dashboard to view the details.`,
    },
    rejected: {
      userId: seekerId, sesTo: candidateEmail,
      title: `Application update – ${jt}`,
      body:  `Your application for ${jt} was not progressed`,
      sesSubject: `Application Update – ${jt}`,
      sesBody: `Thank you for applying for: ${jt}.\n\nAfter careful consideration, we will not be progressing your application at this time.\n\nWe wish you the best in your search.`,
    },
    withdrawn: {
      userId: recruiterId, sesTo: recruiterId,
      title: `Withdrawn – ${candidateName || 'Candidate'}`,
      body:  `${candidateName || 'Candidate'} withdrew their application for ${jt}`,
      sesSubject: `Application Withdrawn: ${candidateName || 'Candidate'} – ${jt}`,
      sesBody: `${candidateName || 'Candidate'} has withdrawn their application for: ${jt}.\n\nApplication ID: ${applicationId}`,
    },
  };

  const n = NOTIF_MAP[newStatus];
  if (!n || !n.userId) return;

  await createNotification(n.userId, newStatus, applicationId, jobId, n.title, n.body);

  if (SES_FROM_EMAIL && n.sesTo) {
    ses.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [n.sesTo] },
      Message: { Subject: { Data: n.sesSubject }, Body: { Text: { Data: n.sesBody } } },
    })).catch(e => console.error(`notifyStatusChange SES (${newStatus}):`, e.message));
  }
}

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/interview', limiter);
app.use('/applications', limiter);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /applications â€” seeker submits application, AI scores profile, auto-
// invites if above threshold, otherwise notifies recruiter of low-score app.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/applications', async (req, res) => {
  try {
    const { jobId, seekerId, candidateName, candidateEmail, cvText, coverLetter } = req.body;

    // â”€â”€ 1. Validate input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!jobId || !seekerId || !candidateName || !candidateEmail || !cvText) {
      return res.status(400).json({ error: 'jobId, seekerId, candidateName, candidateEmail, and cvText are required' });
    }
    if (typeof cvText !== 'string' || cvText.length > 20000) {
      return res.status(400).json({ error: 'cvText must be a string under 20000 characters' });
    }

    // â”€â”€ 2. Load job record â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    const scoreThreshold           = typeof job.scoreThreshold === 'number' ? job.scoreThreshold : 50;
    const interviewMode             = job.interviewMode || 'auto';   // auto | template | custom
    const jobDescription            = job.description || '';
    const recruiterEmail            = job.recruiterId || '';         // stored as recruiter email in recruiterId field
    const jobTitle                  = job.title || 'this role';
    const recommendationThreshold   = typeof job.recommendationThreshold === 'number' ? job.recommendationThreshold : 75;

    // â”€â”€ 3. AI profile scoring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const { score: aiProfileScore, reasoning } = await scoreProfileWithAI(jobDescription, cvText);
    console.log(`[Applications] ${candidateName} scored ${aiProfileScore}/100 (threshold: ${scoreThreshold})`);

    // â”€â”€ 4. Save application record â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const applicationId   = `app_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now             = new Date().toISOString();
    const initialStatus   = aiProfileScore >= scoreThreshold ? 'interview_invited' : 'applied';

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

    // â”€â”€ 5. Below threshold â€” notify recruiter and return â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Always notify recruiter of new application (in-app)
    createNotification(recruiterEmail, 'new_application', applicationId, jobId,
      `New application \u2013 ${candidateName}`,
      ` applied for ${jobTitle}. AI score: ${aiProfileScore}/100`
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

    // â”€â”€ 6. Resolve interview questions based on interviewMode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // interviewMode === 'auto': leave customQuestions null â€” engine calls generateQuestionsFromJD on init

    // â”€â”€ 7. Create interview session records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const interviewId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const attendeeId  = `att_${Math.random().toString(36).substr(2, 9)}`;
    const sessionId   = `sess_${Math.random().toString(36).substr(2, 9)}`;
    const linkToken   = generateLinkToken(interviewId);
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // AIInterviewSessions table â€” links session back to this application
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

    // Existing InterviewSessions META record â€” required by existing interview engine
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

    // â”€â”€ 8. Send invitation email to candidate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const interviewLink = `https://d5k7p6fyxagls.cloudfront.net/interview.html?id=${interviewId}&token=${linkToken}`;
    sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink).catch(() => {});
    createNotification(seekerId, 'interview_invited', applicationId, jobId,
      `Interview invitation \u2013 ${jobTitle}`,
      `You've been invited to an AI interview for ${jobTitle}`
    ).catch(() => {});

    console.log(`âœ… Auto-invited ${candidateName} (score ${aiProfileScore}/100, mode: ${interviewMode})`);

    res.status(201).json({
      applicationId,
      interviewId,
      interviewLink,
      status: 'interview_invited',
      aiProfileScore,
      interviewMode,
      expiresAt,
    });
  } catch (error) {
    console.error('Error processing application:', error);
    res.status(500).json({ error: 'Failed to process application' });
  }
});

// ── GET /applications ──────────────────────────────────────────────────
app.get('/applications', requireAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: APPLICATIONS_TABLE,
      IndexName: 'ApplicationsByRecruiter',
      KeyConditionExpression: 'recruiterId = :rid',
      ExpressionAttributeValues: { ':rid': req.recruiterEmail },
    }));
    res.json({ applications: result.Items || [] });
  } catch (error) {
    console.error('Error listing applications:', error);
    res.status(500).json({ error: 'Failed to list applications' });
  }
});

// ── PATCH /applications/:applicationId/status ──────────────────────────
const VALID_PIPELINE_STATUSES = [
  'applied', 'interview_invited', 'ai_interview_complete', 'recommended',
  'shortlisted', 'human_interview', 'offered', 'hired', 'rejected',
];

app.patch('/applications/:applicationId/status', requireAuth, async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { status, jobId } = req.body;
    if (!status || !VALID_PIPELINE_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid or missing status' });
    }
    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ error: 'jobId is required' });
    }
    // Load application for notification context
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
    // Trigger seeker or recruiter notification for status change
    const NOTIFY_STATUSES = new Set(['shortlisted','human_interview','offered','rejected','withdrawn']);
    if (NOTIFY_STATUSES.has(status)) {
      notifyStatusChange(status, {
        applicationId, jobId,
        seekerId:      appItem.seekerId,
        recruiterId:   appItem.recruiterId || req.recruiterEmail,
        candidateName: appItem.candidateName,
        candidateEmail: appItem.candidateEmail,
        jobTitle:      appItem.jobTitle || null,
      }).catch(() => {});
    }
    res.json({ applicationId, status });
  } catch (error) {
    console.error('Error updating application status:', error);
    res.status(500).json({ error: 'Failed to update application status' });
  }
});

// ── GET /applications/:applicationId/report ────────────────────────────
app.get('/applications/:applicationId/report', requireAuth, async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error fetching application report:', error);
    res.status(500).json({ error: 'Failed to fetch application report' });
  }
});

// ── GET /jobs ─────────────────────────────────────────────────────────
app.get('/jobs', requireAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: JOBS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `RECRUITER#${req.recruiterEmail}` },
      ScanIndexForward: false,
    }));
    res.json({ jobs: result.Items || [] });
  } catch (error) {
    console.error('Error listing jobs:', error);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

// ── POST /jobs ────────────────────────────────────────────────────────
app.post('/jobs', requireAuth, async (req, res) => {
  try {
    const {
      title, description, requirements, location, employmentType,
      salaryMin, salaryMax, salaryCurrency,
      scoreThreshold, recommendationThreshold,
      interviewMode, questionTemplateId, customQuestions, status,
    } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'description is required' });
    }
    if (typeof description === 'string' && description.length > 30000) {
      return res.status(400).json({ error: 'description is too long' });
    }

    const validStatuses = ['draft', 'open', 'paused', 'closed'];
    const validModes = ['auto', 'template', 'custom'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    if (interviewMode && !validModes.includes(interviewMode)) {
      return res.status(400).json({ error: 'Invalid interviewMode' });
    }
    if (Array.isArray(customQuestions) && customQuestions.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 custom questions' });
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();
    const jobStatus = validStatuses.includes(status) ? status : 'draft';
    const mode = validModes.includes(interviewMode) ? interviewMode : 'auto';

    await ddb.send(new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        pk: `RECRUITER#${req.recruiterEmail}`,
        sk: `JOB#${jobId}`,
        jobId,
        recruiterId: req.recruiterEmail,
        title: title.trim(),
        description: description.trim(),
        requirements: Array.isArray(requirements) ? requirements.map(r => String(r).trim()).filter(Boolean) : [],
        location: location ? String(location).trim() : null,
        employmentType: ['full-time', 'part-time', 'contract'].includes(employmentType) ? employmentType : 'full-time',
        salaryRange: (salaryMin != null || salaryMax != null) ? {
          min: typeof salaryMin === 'number' ? salaryMin : null,
          max: typeof salaryMax === 'number' ? salaryMax : null,
          currency: ['GBP', 'USD', 'EUR'].includes(salaryCurrency) ? salaryCurrency : 'GBP',
        } : null,
        scoreThreshold: typeof scoreThreshold === 'number' ? Math.min(100, Math.max(0, Math.round(scoreThreshold))) : 65,
        recommendationThreshold: typeof recommendationThreshold === 'number' ? Math.min(100, Math.max(0, Math.round(recommendationThreshold))) : 75,
        interviewMode: mode,
        questionTemplateId: mode === 'template' ? (questionTemplateId || null) : null,
        customQuestions: mode === 'custom' && Array.isArray(customQuestions)
          ? customQuestions.map(q => String(q).trim()).filter(Boolean)
          : null,
        status: jobStatus,
        createdAt: now,
        updatedAt: now,
      },
    }));

    console.log(`[Jobs] Created job "${title.trim()}" (${jobId}) status=${jobStatus} by ${req.recruiterEmail}`);
    res.status(201).json({ jobId, status: jobStatus });
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// ── GET /question-templates ───────────────────────────────────────────
app.get('/question-templates', requireAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: QUESTION_TEMPLATES_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `RECRUITER#${req.recruiterEmail}` },
    }));
    res.json({ templates: result.Items || [] });
  } catch (error) {
    console.error('Error listing question templates:', error);
    res.status(500).json({ error: 'Failed to list question templates' });
  }
});

// ── POST /question-templates ──────────────────────────────────────────
app.post('/question-templates', requireAuth, async (req, res) => {
  try {
    const { name, questions } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: 'questions must be a non-empty array' });
    }
    const cleanedQuestions = questions.map(q => String(q).trim()).filter(Boolean).slice(0, 10);
    if (!cleanedQuestions.length) {
      return res.status(400).json({ error: 'No valid questions provided' });
    }

    const templateId = `tpl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: QUESTION_TEMPLATES_TABLE,
      Item: {
        pk: `RECRUITER#${req.recruiterEmail}`,
        sk: `TEMPLATE#${templateId}`,
        templateId,
        recruiterId: req.recruiterEmail,
        name: name.trim(),
        questions: cleanedQuestions,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      },
    }));
    res.status(201).json({ templateId, name: name.trim() });
  } catch (error) {
    console.error('Error creating question template:', error);
    res.status(500).json({ error: 'Failed to create question template' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    message: 'GitHub Actions deployment - credentials corrected'
  });
});

// Suggest interview questions from CV/JD text
app.post('/interview/suggest-questions', requireAuth, async (req, res) => {
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

// NEW: Create interview link
app.post('/interview/create', requireAuth, async (req, res) => {
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
    const attendeeId = `att_${Math.random().toString(36).substr(2, 9)}`;
    const linkToken = generateLinkToken(interviewId);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await ddb.send(
      new PutCommand({
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
      })
    );

    const interviewLink = `https://d5k7p6fyxagls.cloudfront.net/interview.html?id=${interviewId}&token=${linkToken}`;

    // Send invitation email to candidate (non-blocking, non-fatal)
    sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink).catch(() => {});

    console.log(`âœ… Created interview link for ${candidateName}`);

    res.json({
      interviewId,
      attendeeId,
      interviewLink,
      candidateName,
      candidateEmail,
      expiresAt,
    });
  } catch (error) {
    console.error('Error creating interview:', error);
    res.status(500).json({ error: 'Failed to create interview link' });
  }
});

// Get public interview result (for candidate thank-you page)
app.get('/interview/result/:interviewId', async (req, res) => {
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

// NEW: Validate interview link
app.get('/interview/validate/:interviewId', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const { token } = req.query;

    if (!token || !verifyLinkToken(interviewId, token)) {
      return res.status(403).json({ error: 'Invalid or missing interview token' });
    }

    const result = await ddb.send(
      new GetCommand({
        TableName: SESSION_TABLE,
        Key: {
          pk: `INTERVIEW#${interviewId}`,
          sk: `META`,
        },
      })
    );

    if (!result.Item) {
      return res.status(404).json({ error: 'Interview not found' });
    }

    if (new Date(result.Item.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'Interview link expired' });
    }

    if (result.Item.status === 'completed') {
      return res.status(410).json({ error: 'Interview already completed' });
    }

    res.json({
      valid: true,
      candidateName: result.Item.candidateName,
      attendeeId: result.Item.attendeeId,
      interviewId: result.Item.interviewId,
      jobDescription: result.Item.jobDescription || null,
    });
  } catch (error) {
    console.error('Error validating interview:', error);
    res.status(500).json({ error: 'Failed to validate interview' });
  }
});

// List interview sessions for a recruiter
app.get('/interview/sessions', requireAuth, async (req, res) => {
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
        interviewId: item.interviewId,
        candidateName: item.candidateName,
        candidateEmail: item.candidateEmail,
        status: item.status,
        createdAt: item.createdAt,
        score: item.aiScore || null,
        recommendation: item.aiRecommendation || null,
        summary: item.aiSummary || null,
        expiresAt: item.expiresAt || null,
      }));
    res.json({ sessions });
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Get full conversation transcript for a completed interview
app.get('/interview/transcript/:interviewId', requireAuth, async (req, res) => {
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
      turn: i + 1,
      question: h.q,
      candidateAnswer: h.a,
      aiReply: h.reply,
      timestamp: h.t,
    }));
    res.json({ conversation, turns: conversation.length });
  } catch (error) {
    console.error('Error fetching transcript:', error);
    res.status(500).json({ error: 'Failed to fetch transcript' });
  }
});

// Archive (soft-delete) an interview
app.delete('/interview/:interviewId', requireAuth, async (req, res) => {
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

// Resend invitation email to candidate
app.post('/interview/resend-invite/:interviewId', requireAuth, async (req, res) => {
  try {
    const { interviewId } = req.params;
    if (!interviewId || typeof interviewId !== 'string' || interviewId.length > 100) {
      return res.status(400).json({ error: 'Invalid interview ID' });
    }
    const itemRes = await ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' } }));
    if (!itemRes.Item) return res.status(404).json({ error: 'Interview not found' });
    if (itemRes.Item.recruiterEmail !== req.recruiterEmail) return res.status(403).json({ error: 'Forbidden' });
    if (!SES_FROM_EMAIL) return res.status(503).json({ error: 'Email service not configured' });
    const { candidateName, candidateEmail } = itemRes.Item;
    const interviewLink = `https://d5k7p6fyxagls.cloudfront.net/interview.html?id=${interviewId}`;
    await sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink);
    res.json({ success: true });
  } catch (error) {
    console.error('Error resending invite:', error);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

// Regenerate/extend interview link expiry
app.post('/interview/regenerate/:interviewId', requireAuth, async (req, res) => {
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
    const linkToken = generateLinkToken(interviewId);
    const interviewLink = `https://d5k7p6fyxagls.cloudfront.net/interview.html?id=${interviewId}&token=${linkToken}`;
    res.json({ success: true, expiresAt: newExpiry, interviewLink });
  } catch (error) {
    console.error('Error regenerating link:', error);
    res.status(500).json({ error: 'Failed to regenerate link' });
  }
});

// Existing: Process interview transcript
app.post('/interview/process', async (req, res) => {
  try {
    const { meetingId, attendeeId, transcriptText, isInit, token } = req.body;

    if (!meetingId || typeof meetingId !== 'string' || meetingId.length > 100) {
      return res.status(400).json({ error: 'Invalid meetingId' });
    }

    if (!attendeeId || typeof attendeeId !== 'string' || attendeeId.length > 100) {
      return res.status(400).json({ error: 'Invalid attendeeId' });
    }

    // Verify signed link token
    if (!token || !verifyLinkToken(meetingId, token)) {
      return res.status(403).json({ error: 'Unauthorized: invalid interview token' });
    }

    if (transcriptText && transcriptText.length > 5000) {
      return res.status(400).json({ error: 'Text too long' });
    }

    // On init (or first call), load interview metadata so the engine gets
    // the correct candidate name, JD, and any recruiter-added custom questions
    let jobDescription = null;
    let candidateName = null;
    let customQuestions = null;
    if (isInit === true) {
      try {
        const metaRes = await ddb.send(new GetCommand({
          TableName: SESSION_TABLE,
          Key: { pk: `INTERVIEW#${meetingId}`, sk: 'META' },
        }));
        jobDescription = metaRes.Item?.jobDescription || null;
        candidateName = metaRes.Item?.candidateName || null;
        customQuestions = metaRes.Item?.customQuestions || null;
        console.log(`[/process] init â€” candidate: "${candidateName}", hasJD: ${!!jobDescription}, customQs: ${customQuestions?.length || 0}`);
      } catch (err) {
        console.error('[/process] Failed to load interview metadata:', err.message);
      }
    }

    const result = await processTranscript({
      meetingId,
      attendeeId,
      transcriptText,
      isInit: isInit === true,
      jobDescription,
      candidateName,
      customQuestions,
    });

    // Save full conversation to S3 when interview is done
    if (result.done) {
      await saveInterviewSnapshot(meetingId, attendeeId, 'completed');
    }

    // Generate audio if requested
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

// ── Seeker auth rate limiter ────────────────────────────────────────────
const seekerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
});

// ── Password hashing helpers (Node crypto — no external dependency) ────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

// ── GET /public/jobs ──────────────────────────────────────────────────
// Returns all open jobs. No authentication required.
// Query params: search, location, employmentType
app.get('/public/jobs', async (req, res) => {
  try {
    const { search, location, employmentType } = req.query;
    const result = await ddb.send(new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: 'JobsByStatus',
      KeyConditionExpression: '#st = :st',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':st': 'open' },
    }));
    let jobs = result.Items || [];

    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim().toLowerCase();
      jobs = jobs.filter(j =>
        (j.title || '').toLowerCase().includes(q) ||
        (j.description || '').toLowerCase().includes(q),
      );
    }
    if (location && typeof location === 'string' && location.trim()) {
      const loc = location.trim().toLowerCase();
      jobs = jobs.filter(j => (j.location || '').toLowerCase().includes(loc));
    }
    if (employmentType && typeof employmentType === 'string') {
      jobs = jobs.filter(j => j.employmentType === employmentType);
    }

    const publicJobs = jobs.map(j => ({
      jobId: j.jobId,
      title: j.title,
      location: j.location,
      employmentType: j.employmentType,
      salaryRange: j.salaryRange,
      requirements: j.requirements,
      createdAt: j.createdAt,
      // Strip internal fields
      description: (j.description || '').substring(0, 500),
    }));

    res.json({ jobs: publicJobs });
  } catch (error) {
    console.error('Error listing public jobs:', error);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

// ── GET /public/jobs/:jobId ───────────────────────────────────────────
app.get('/public/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!jobId || typeof jobId !== 'string' || jobId.length > 100) {
      return res.status(400).json({ error: 'Invalid job ID' });
    }
    const result = await ddb.send(new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: 'JobsByJobId',
      KeyConditionExpression: 'jobId = :jid',
      ExpressionAttributeValues: { ':jid': jobId },
      Limit: 1,
    }));
    const job = result.Items && result.Items[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'open') return res.status(404).json({ error: 'Job not found' });

    res.json({
      jobId: job.jobId,
      title: job.title,
      description: job.description,
      requirements: job.requirements,
      location: job.location,
      employmentType: job.employmentType,
      salaryRange: job.salaryRange,
      interviewMode: job.interviewMode,
      createdAt: job.createdAt,
    });
  } catch (error) {
    console.error('Error fetching public job:', error);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// ── POST /seeker/auth/signup ───────────────────────────────────────────
app.post('/seeker/auth/signup', seekerAuthLimiter, async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    const normalEmail = email.toLowerCase().trim();

    // Check for existing user
    const existing = await ddb.send(new QueryCommand({
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
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({
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
      SEEKER_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '7d' },
    );
    console.log(`[Seeker] Signup: ${normalEmail} (${userId})`);
    res.status(201).json({ token, userId, email: normalEmail, fullName: fullName.trim() });
  } catch (error) {
    console.error('Error in seeker signup:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// ── POST /seeker/auth/login ────────────────────────────────────────────
app.post('/seeker/auth/login', seekerAuthLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const normalEmail = email.toLowerCase().trim();
    const result = await ddb.send(new QueryCommand({
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
      SEEKER_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '7d' },
    );
    res.json({
      token,
      userId: user.userId,
      email: normalEmail,
      fullName: user.fullName || '',
      profileComplete: user.profileComplete || 0,
    });
  } catch (error) {
    console.error('Error in seeker login:', error);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

// ── GET /seeker/profile ────────────────────────────────────────────────
app.get('/seeker/profile', requireSeekerAuth, async (req, res) => {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { pk: `USER#${req.seekerId}`, sk: 'PROFILE' },
    }));
    if (!result.Item) return res.status(404).json({ error: 'Profile not found' });
    const u = result.Item;
    res.json({
      userId: u.userId,
      email: u.email,
      fullName: u.fullName,
      location: u.location,
      skills: u.skills || [],
      availability: u.availability,
      bio: u.bio,
      cvUrl: u.cvUrl,
      profileComplete: u.profileComplete || 0,
      createdAt: u.createdAt,
    });
  } catch (error) {
    console.error('Error fetching seeker profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ── PUT /seeker/profile ────────────────────────────────────────────────
app.put('/seeker/profile', requireSeekerAuth, async (req, res) => {
  try {
    const { fullName, location, skills, availability, bio } = req.body;
    const validAvailabilities = ['immediately', '2_weeks', '1_month', '3_months', 'not_looking'];

    const cleanName = fullName ? String(fullName).trim() : null;
    const cleanLoc  = location  ? String(location).trim()  : null;
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
    if (cleanName  !== null) merged.fullName     = cleanName;
    if (cleanLoc   !== null) merged.location     = cleanLoc;
    if (cleanSkills !== null) merged.skills      = cleanSkills;
    if (cleanAvail !== null) merged.availability = cleanAvail;
    if (cleanBio   !== null) merged.bio          = cleanBio;
    merged.updatedAt = new Date().toISOString();

    // Recalculate completion %
    let score = 20; // base for having an account
    if (merged.fullName)     score += 15;
    if (merged.location)     score += 15;
    if (merged.skills && merged.skills.length) score += 15;
    if (merged.availability) score += 10;
    if (merged.bio)          score += 10;
    if (merged.cvUrl)        score += 15;
    merged.profileComplete = Math.min(100, score);

    await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: merged }));
    res.json({ profileComplete: merged.profileComplete });
  } catch (error) {
    console.error('Error updating seeker profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── POST /seeker/profile/cv ────────────────────────────────────────────
// Accepts base64-encoded file and uploads to S3 on behalf of the seeker.
app.post('/seeker/profile/cv', requireSeekerAuth, async (req, res) => {
  try {
    const { base64, mimeType, filename } = req.body;
    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({ error: 'base64 file data is required' });
    }
    const allowedTypes = ['application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const safeMime = allowedTypes.includes(mimeType) ? mimeType : 'application/pdf';

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.byteLength > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'CV file must be under 10MB' });
    }

    const ext = safeMime === 'application/pdf' ? 'pdf'
      : safeMime === 'application/msword' ? 'doc' : 'docx';
    const s3Key = `cvs/${req.seekerId}/${Date.now()}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_CV_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: safeMime,
      ServerSideEncryption: 'AES256',
    }));

    const cvUrl = `https://${S3_CV_BUCKET}.s3.${REGION}.amazonaws.com/${s3Key}`;

    // Update profile with CV URL and recalculate completion
    const existing = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { pk: `USER#${req.seekerId}`, sk: 'PROFILE' },
    }));
    if (existing.Item) {
      const merged = { ...existing.Item, cvS3Key: s3Key, cvUrl, updatedAt: new Date().toISOString() };
      let score = 20;
      if (merged.fullName)     score += 15;
      if (merged.location)     score += 15;
      if (merged.skills && merged.skills.length) score += 15;
      if (merged.availability) score += 10;
      if (merged.bio)          score += 10;
      if (merged.cvUrl)        score += 15;
      merged.profileComplete = Math.min(100, score);
      await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: merged }));
    }

    res.json({ cvUrl, s3Key });
  } catch (error) {
    console.error('Error uploading CV:', error);
    res.status(500).json({ error: 'Failed to upload CV' });
  }
});

// ── GET /seeker/applications ───────────────────────────────────────────
app.get('/seeker/applications', requireSeekerAuth, async (req, res) => {
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

    // Enrich with job titles
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
              a.jobTitle = job.title;
              a.jobLocation = job.location;
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

// ── GET /seeker/applications/:id ───────────────────────────────────────
app.get('/seeker/applications/:id', requireSeekerAuth, async (req, res) => {
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

    // Enrich with job details
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
    } catch { /* skip enrichment on error */ }

    res.json({
      applicationId:       app.applicationId,
      jobId:               app.jobId,
      jobTitle:            job ? job.title : null,
      jobLocation:         job ? job.location : null,
      jobEmploymentType:   job ? job.employmentType : null,
      candidateName:       app.candidateName,
      status:              app.status,
      aiProfileScore:      app.aiProfileScore,
      aiProfileReasoning:  app.aiProfileReasoning,
      recommended:         app.recommended,
      coverLetter:         app.coverLetter,
      appliedAt:           app.appliedAt,
      updatedAt:           app.updatedAt,
    });
  } catch (error) {
    console.error('Error fetching seeker application detail:', error);
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

// ── GET /notifications  (recruiter) ──────────────────────────────────
app.get('/notifications', requireAuth, async (req, res) => {
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

// ── POST /notifications/read-all  (recruiter) ─────────────────────────
app.post('/notifications/read-all', requireAuth, async (req, res) => {
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

// ── POST /notifications/:id/read  (recruiter) ─────────────────────────
app.post('/notifications/:id/read', requireAuth, async (req, res) => {
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

// ── GET /seeker/notifications ──────────────────────────────────────────
app.get('/seeker/notifications', requireSeekerAuth, async (req, res) => {
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

// ── POST /seeker/notifications/read-all ───────────────────────────────
app.post('/seeker/notifications/read-all', requireSeekerAuth, async (req, res) => {
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

// ── POST /seeker/notifications/:id/read ───────────────────────────────
app.post('/seeker/notifications/:id/read', requireSeekerAuth, async (req, res) => {
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

// ── POST /seeker/applications/:id/withdraw ───────────────────────────
app.post('/seeker/applications/:id/withdraw', requireSeekerAuth, async (req, res) => {
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

// ── GET /applications/:id/messages  (recruiter) ───────────────────────
app.get('/applications/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.length > 100) return res.status(400).json({ error: 'Invalid id' });
    const result = await ddb.send(new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `APPLICATION#${id}` },
      ScanIndexForward: true,
    }));
    res.json({ messages: result.Items || [] });
  } catch (err) {
    console.error('GET /applications/:id/messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ── POST /applications/:id/messages  (recruiter) ──────────────────────
app.post('/applications/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { body: msgBody, jobId } = req.body;
    if (!id || typeof id !== 'string' || id.length > 100) return res.status(400).json({ error: 'Invalid id' });
    if (!msgBody || typeof msgBody !== 'string' || msgBody.trim().length === 0) return res.status(400).json({ error: 'Message body required' });
    if (msgBody.length > 3000) return res.status(400).json({ error: 'Message too long (max 3000 chars)' });
    const now = new Date().toISOString();
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const message = {
      pk: `APPLICATION#${id}`,
      sk: `MSG#${now}#${msgId}`,
      messageId: msgId, applicationId: id,
      senderId: req.recruiterEmail, senderName: req.recruiterEmail.split('@')[0],
      senderRole: 'recruiter', body: msgBody.trim(), sentAt: now,
    };
    await ddb.send(new PutCommand({ TableName: MESSAGES_TABLE, Item: message }));

    // Notify seeker of new message
    if (jobId) {
      const appRes = await ddb.send(new GetCommand({
        TableName: APPLICATIONS_TABLE,
        Key: { pk: `JOB#${jobId}`, sk: `APPLICATION#${id}` },
      }));
      const appItem = appRes.Item || {};
      if (appItem.seekerId) {
        createNotification(appItem.seekerId, 'new_message', id, jobId,
          `New message from recruiter`,
          msgBody.trim().slice(0, 120) + (msgBody.length > 120 ? '…' : '')
        ).catch(() => {});
      }
    }
    res.status(201).json({ message });
  } catch (err) {
    console.error('POST /applications/:id/messages error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── GET /seeker/applications/:id/messages ─────────────────────────────
app.get('/seeker/applications/:id/messages', requireSeekerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.length > 100) return res.status(400).json({ error: 'Invalid id' });
    // Verify ownership
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

// ── POST /seeker/applications/:id/messages ────────────────────────────
app.post('/seeker/applications/:id/messages', requireSeekerAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { body: msgBody } = req.body;
    if (!id || typeof id !== 'string' || id.length > 100) return res.status(400).json({ error: 'Invalid id' });
    if (!msgBody || typeof msgBody !== 'string' || msgBody.trim().length === 0) return res.status(400).json({ error: 'Message body required' });
    if (msgBody.length > 3000) return res.status(400).json({ error: 'Message too long (max 3000 chars)' });
    // Verify ownership
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

    const now = new Date().toISOString();
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const message = {
      pk: `APPLICATION#${id}`,
      sk: `MSG#${now}#${msgId}`,
      messageId: msgId, applicationId: id,
      senderId: req.seekerId, senderName,
      senderRole: 'seeker', body: msgBody.trim(), sentAt: now,
    };
    await ddb.send(new PutCommand({ TableName: MESSAGES_TABLE, Item: message }));

    // Notify recruiter of new message
    if (app.recruiterId) {
      createNotification(app.recruiterId, 'new_message', id, app.jobId,
        `New message from ${senderName}`,
        msgBody.trim().slice(0, 120) + (msgBody.length > 120 ? '...' : '')
      ).catch(() => {});
    }
    res.status(201).json({ message });
  } catch (err) {
    console.error('POST /seeker/applications/:id/messages error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});


// ── POST /seeker/auth/forgot-password ─────────────────────────────────
// Accepts: { email }
// Stores a time-limited reset token in DynamoDB and sends an email via SES.
app.post('/seeker/auth/forgot-password', seekerAuthLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    const normalEmail = email.toLowerCase().trim();

    // Look up user (always respond 200 to prevent email enumeration)
    const result = await ddb.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'UsersByEmail',
      KeyConditionExpression: 'email = :em',
      ExpressionAttributeValues: { ':em': normalEmail },
      Limit: 1,
    }));
    const user = result.Items && result.Items[0];
    if (!user) {
      // Don't reveal whether the email exists
      return res.json({ message: 'If that email is registered, a reset link has been sent.' });
    }

    // Generate a secure token expiring in 1 hour
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { pk: `USER#${user.userId}`, sk: 'PROFILE' },
      UpdateExpression: 'SET resetToken = :t, resetExpiry = :e',
      ExpressionAttributeValues: { ':t': resetToken, ':e': resetExpiry },
    }));

    // Send reset email via SES
    if (SES_FROM_EMAIL) {
      const frontendBase = process.env.FRONTEND_URL || 'https://d5k7p6fyxagls.cloudfront.net';
      const resetLink = `${frontendBase}/seeker-reset-password.html?token=${resetToken}&email=${encodeURIComponent(normalEmail)}`;
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
  } catch (err) {
    console.error('POST /seeker/auth/forgot-password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ── POST /seeker/auth/reset-password ──────────────────────────────────
// Accepts: { email, token, newPassword }
app.post('/seeker/auth/reset-password', seekerAuthLimiter, async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'email, token, and newPassword are required' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const normalEmail = email.toLowerCase().trim();

    const result = await ddb.send(new QueryCommand({
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

    // Set new password, clear reset token
    await ddb.send(new UpdateCommand({
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
  } catch (err) {
    console.error('POST /seeker/auth/reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Load HTTPS certificate and key
const certPath = path.join(__dirname, '../certs/server.crt');
const keyPath = path.join(__dirname, '../certs/server.key');
const USE_HTTPS = process.env.USE_HTTPS !== 'false' && fs.existsSync(certPath) && fs.existsSync(keyPath);

let server;
if (USE_HTTPS) {
  // Production: Use HTTPS with certificate
  const options = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
  server = https.createServer(options, app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ðŸš€ Interview server running SECURELY on https://0.0.0.0:${PORT}`);
    console.log(`ðŸ“ Certificate: ${certPath}`);
  });
} else {
  // Development/Testing: Use HTTP
  console.warn('âš ï¸  Using HTTP (development mode)');
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`ðŸš€ Interview server running on http://0.0.0.0:${PORT}`);
  });
}

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

      // Handle explicit end from candidate (stop button)
      if (data.type === 'end') {
        if (meetingId && attendeeId) {
          await saveInterviewSnapshot(meetingId, attendeeId, 'ended_by_candidate');
        }
        ws.send(JSON.stringify({ type: 'ended' }));
        return;
      }

      // Handle initialization
      if (data.type === 'init') {
        const mid = meetingId || data.meetingId;
        const aid = attendeeId || data.attendeeId;

        // Verify the signed link token before allowing interview to start
        if (!data.token || !verifyLinkToken(mid, data.token)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized: invalid interview token' }));
          ws.close(1008, 'Unauthorized');
          return;
        }

        // Load job description and candidate name from interview metadata
        let jobDescription = null;
        let candidateName = null;
          let customQuestions = null;
          try {
            const metaRes = await ddb.send(new GetCommand({
              TableName: SESSION_TABLE,
              Key: { pk: `INTERVIEW#${mid}`, sk: 'META' },
            }));
            jobDescription = metaRes.Item?.jobDescription || null;
            candidateName = metaRes.Item?.candidateName || null;
            customQuestions = metaRes.Item?.customQuestions || null;
          } catch (err) {
            console.error('Could not load interview metadata for init:', err);
          }

          const result = await processTranscript({
            meetingId: mid,
            attendeeId: aid,
            transcriptText: '',
            isInit: true,
            jobDescription,
            candidateName,
            customQuestions,
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

        // Save snapshot when interview completes via WebSocket
        if (result.done) {
          await saveInterviewSnapshot(meetingId, attendeeId, 'completed');
        }
      }
    } catch (error) {
      console.error('WebSocket error:', error);
      ws.send(JSON.stringify({ type: 'error', error: error.message }));
    }
  });

  ws.on('close', async () => {
    console.log(`WebSocket closed: ${meetingId}/${attendeeId}`);
    // Save snapshot on disconnect (connection lost, browser closed, etc.)
    // Only save if interview was actually started (meetingId set during 'connect')
    if (meetingId && attendeeId) {
      await saveInterviewSnapshot(meetingId, attendeeId, 'disconnected');
    }
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
