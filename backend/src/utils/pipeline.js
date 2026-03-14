// Interview lifecycle helpers: saving snapshots to S3, post-interview pipeline
// scoring, and Polly speech synthesis.

import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  ddb, s3, polly, sqs,
  SESSION_TABLE, APPLICATIONS_TABLE, INTERVIEW_REPORTS_TABLE, S3_CV_BUCKET, SES_FROM_EMAIL,
  SQS_REPORT_RETRY_QUEUE_URL,
} from './clients.js';
import { ddbSend } from './aws-wrappers.js';
import { generateCandidateSummary } from '../interview-engine.js';
import { generateInterviewReport } from '../bedrock-client.js';
import { sendRecruiterEmail, sendInterviewCompleteNotification } from './email.js';
import { createNotification } from './notifications.js';

export async function generateSpeech(text) {
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

/**
 * Attempts Polly speech synthesis. On any failure:
 *  - Logs a structured CloudWatch entry
 *  - Sets fallbackMode = true on the InterviewSession DDB record (if interviewId given)
 *  - Returns null — callers should switch to text mode
 */
export async function generateSpeechWithFallback(text, interviewId) {
  try {
    return await generateSpeech(text);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR', event: 'polly_failed',
      interviewId: interviewId || null,
      reason: err.message,
      timestamp: new Date().toISOString(),
    }));
    if (interviewId) {
      try {
        await ddb.send(new UpdateCommand({
          TableName: SESSION_TABLE,
          Key: { pk: `INTERVIEW#${interviewId}`, sk: 'META' },
          UpdateExpression: 'SET fallbackMode = :t, updatedAt = :now',
          ExpressionAttributeValues: { ':t': true, ':now': new Date().toISOString() },
        }));
      } catch { /* ignore — best-effort update */ }
    }
    return null; // Signal caller: drop to text mode
  }
}

export async function saveInterviewSnapshot(meetingId, attendeeId, status) {
  try {
    const [stateRes, metaRes] = await Promise.all([
      ddbSend(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `MEETING#${meetingId}`, sk: `ATTENDEE#${attendeeId}` } })),
      ddbSend(new GetCommand({ TableName: SESSION_TABLE, Key: { pk: `INTERVIEW#${meetingId}`, sk: `META` } })),
    ]);
    const state = stateRes.Item || {};
    const meta  = metaRes.Item  || {};

    // Generate AI summary for non-pipeline interviews
    let aiSummary = null;
    if (status === 'completed' && !meta.applicationId && state.history && state.history.length > 0) {
      try {
        aiSummary = await generateCandidateSummary(
          state.history,
          meta.candidateName || 'Unknown',
          state.jobDescription || meta.jobDescription || null,
        );
        console.log(`✅ AI summary generated for ${meetingId}: ${aiSummary?.recommendation} (${aiSummary?.score}/10)`);
      } catch (err) {
        console.error('❌ Failed to generate AI summary:', err);
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
      Bucket: S3_CV_BUCKET,
      Key: `interviews/${meetingId}/${status}-${Date.now()}.json`,
      Body: JSON.stringify(snapshot, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));

    let updateExpr = 'SET #st = :status, updatedAt = :now';
    const exprNames  = { '#st': 'status' };
    const exprValues = { ':status': status, ':now': new Date().toISOString() };
    if (aiSummary) {
      updateExpr += ', aiScore = :score, aiRecommendation = :rec, aiSummary = :summary';
      exprValues[':score']   = aiSummary.score;
      exprValues[':rec']     = aiSummary.recommendation;
      exprValues[':summary'] = aiSummary.summary;
    }

    await ddbSend(new UpdateCommand({
      TableName: SESSION_TABLE,
      Key: { pk: `INTERVIEW#${meetingId}`, sk: `META` },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }));

    if (status === 'completed') {
      if (meta.applicationId) {
        finalizeInterviewPipeline(meetingId, meta, state.history || [], state.jobDescription || meta.jobDescription || null)
          .catch(async (err) => {
            const failedAt = new Date().toISOString();
            console.error(`\u274C Pipeline finalization failed for ${meetingId}:`, err.message);
            // Mark session as pending_report so the candidate sees it as complete
            try {
              await ddbSend(new UpdateCommand({
                TableName: SESSION_TABLE,
                Key: { pk: `INTERVIEW#${meetingId}`, sk: 'META' },
                UpdateExpression: 'SET #st = :s, updatedAt = :now',
                ExpressionAttributeNames: { '#st': 'status' },
                ExpressionAttributeValues: { ':s': 'pending_report', ':now': failedAt },
              }));
            } catch (updateErr) {
              console.error('[Pipeline] Failed to set pending_report status:', updateErr.message);
            }
            // Queue for async retry
            if (SQS_REPORT_RETRY_QUEUE_URL) {
              try {
                await sqs.send(new SendMessageCommand({
                  QueueUrl: SQS_REPORT_RETRY_QUEUE_URL,
                  MessageBody: JSON.stringify({
                    interviewId: meetingId,
                    applicationId: meta.applicationId || null,
                    jobId: meta.jobId || null,
                    failedAt,
                  }),
                  DelaySeconds: 120, // 2 minutes
                }));
                console.log(`[Pipeline] Queued report retry for ${meetingId}`);
              } catch (sqsErr) {
                console.error('[Pipeline] Failed to queue report retry:', sqsErr.message);
              }
            }
          });
      } else if (meta.recruiterEmail && SES_FROM_EMAIL) {
        await sendRecruiterEmail(meta.recruiterEmail, meta.candidateName, aiSummary, meetingId);
      }
    }

    console.log(`✅ Interview snapshot saved (${meetingId}, status: ${status}, turns: ${snapshot.conversation.length})`);
  } catch (err) {
    console.error('❌ Failed to save interview snapshot:', err);
  }
}

export async function finalizeInterviewPipeline(interviewId, meta, history, jobDescription) {
  const tag = `[Pipeline:${interviewId}]`;
  try {
    const report = await generateInterviewReport(
      history,
      meta.candidateName || 'Unknown',
      jobDescription,
    );

    const appKey = { pk: `JOB#${meta.jobId}`, sk: `APPLICATION#${meta.applicationId}` };
    const appRes = await ddbSend(new GetCommand({ TableName: APPLICATIONS_TABLE, Key: appKey }));
    const app    = appRes.Item || {};
    const aiProfileScore = typeof app.aiProfileScore === 'number' ? app.aiProfileScore : 0;

    const aiInterviewScore       = report.aiInterviewScore;
    const combinedScore          = Math.round((aiProfileScore * 0.4) + (aiInterviewScore * 0.6));
    const recommendationThreshold = typeof meta.recommendationThreshold === 'number' ? meta.recommendationThreshold : 75;
    const autoRecommended         = combinedScore >= recommendationThreshold;
    const jobTitle                = meta.jobTitle || 'the role';

    console.log(`${tag} combinedScore: ${combinedScore} (profile ${aiProfileScore}×0.4 + interview ${aiInterviewScore}×0.6), autoRecommended: ${autoRecommended}`);

    const now = new Date().toISOString();
    await ddbSend(new PutCommand({
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

    await ddbSend(new UpdateCommand({
      TableName: APPLICATIONS_TABLE,
      Key: appKey,
      UpdateExpression: 'SET aiInterviewScore = :iScore, combinedScore = :cScore, recommended = :rec, #st = :st, updatedAt = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':iScore': aiInterviewScore,
        ':cScore': combinedScore,
        ':rec':    autoRecommended,
        ':st':     autoRecommended ? 'recommended' : 'ai_interview_complete',
        ':now':    now,
      },
    }));

    const recruiterEmail = meta.recruiterEmail || app.recruiterId || '';
    await sendInterviewCompleteNotification(recruiterEmail, meta.candidateName, jobTitle, combinedScore, interviewId);

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
