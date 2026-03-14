// Resilient wrappers for every AWS service the platform uses.
// Import these instead of calling service clients directly.
//
// DynamoDB  — ddbSend()           retries on throttle, throws DATABASE_UNAVAILABLE after 3 attempts
// S3        — s3Upload()          30-second timeout, throws UPLOAD_FAILED on any error
// SES       — sesSend()           never throws; logs to CloudWatch and queues SQS retry on failure
// AI scoring — scoreWithFallback() queues SQS retry on failure, returns null score so app still saves
//
// Polly / Transcribe fallback lives in utils/pipeline.js (generateSpeechWithFallback) to
// avoid a circular import through email.js.

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  ddb, s3, ses, sqs,
  SESSION_TABLE,
  SQS_EMAIL_RETRY_QUEUE_URL,
  SQS_SCORING_RETRY_QUEUE_URL,
} from './clients.js';
import { AppError, ERROR_CODES } from './errors.js';
import { scoreProfileWithAI } from '../bedrock-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// DynamoDB — retry on throughput / throttle errors
// ─────────────────────────────────────────────────────────────────────────────

const DDB_RETRYABLE = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'TransactionConflictException',
]);

const DDB_DELAYS_MS = [200, 400, 800]; // exponential backoff delays

/**
 * Drop-in replacement for `ddb.send(command)`.
 * Retries up to 3 times on throughput errors, then throws DATABASE_UNAVAILABLE.
 * Non-retryable errors (e.g. ConditionalCheckFailedException) pass through immediately.
 */
export async function ddbSend(command) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await ddb.send(command);
    } catch (err) {
      const isRetryable = DDB_RETRYABLE.has(err.name) || DDB_RETRYABLE.has(err.__type);
      if (isRetryable && attempt < 3) {
        console.warn(JSON.stringify({
          level: 'WARN',
          event: 'ddb_throttle_retry',
          attempt: attempt + 1,
          error: err.name,
          timestamp: new Date().toISOString(),
        }));
        await new Promise(r => setTimeout(r, DDB_DELAYS_MS[attempt]));
        lastErr = err;
        continue;
      }
      if (isRetryable) {
        // Exhausted all retries
        console.error(JSON.stringify({
          level: 'ERROR',
          event: 'ddb_unavailable',
          error: err.message,
          timestamp: new Date().toISOString(),
        }));
        throw new AppError('Database is temporarily unavailable. Please try again.', 503, ERROR_CODES.DATABASE_UNAVAILABLE);
      }
      throw err; // Non-retryable — pass through as-is
    }
  }
  // Should never reach here, but satisfy linter
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// S3 — upload with 30-second hard timeout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps an S3 PutObject upload with a 30-second AbortController timeout.
 * On any failure (timeout, permission, network) throws UPLOAD_FAILED.
 *
 * @param {object} params — same fields as PutObjectCommand input
 */
export async function s3Upload(params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await s3.send(new PutObjectCommand(params), { abortSignal: controller.signal });
  } catch (err) {
    const isTimeout = err.name === 'AbortError' || controller.signal.aborted;
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 's3_upload_failed',
      bucket: params.Bucket,
      key: params.Key,
      reason: isTimeout ? 'timeout_30s' : err.message,
      timestamp: new Date().toISOString(),
    }));
    throw new AppError("We couldn't save your file. Please try again.", 502, ERROR_CODES.UPLOAD_FAILED);
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SES — fire-and-forget with SQS retry queue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends an SES command without ever throwing to the caller.
 * On failure: logs a structured CloudWatch entry and enqueues the message
 * to SQS_EMAIL_RETRY_QUEUE_URL with a 5-minute delivery delay.
 *
 * @param {import('@aws-sdk/client-ses').SendEmailCommand} command
 * @param {{ recipient?: string, template?: string }} meta  — used only for logging
 */
export async function sesSend(command, meta = {}) {
  try {
    return await ses.send(command);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'ses_send_failed',
      recipient: meta.recipient || 'unknown',
      template: meta.template || 'unknown',
      reason: err.message,
      timestamp: new Date().toISOString(),
    }));

    if (SQS_EMAIL_RETRY_QUEUE_URL) {
      try {
        await sqs.send(new SendMessageCommand({
          QueueUrl: SQS_EMAIL_RETRY_QUEUE_URL,
          MessageBody: JSON.stringify({
            commandInput: command.input,
            meta,
            retryAfter: Date.now() + 5 * 60 * 1000,
          }),
          DelaySeconds: 300, // SQS max delay = 15 min; 5 min here
        }));
        console.log(JSON.stringify({
          level: 'INFO',
          event: 'ses_retry_queued',
          recipient: meta.recipient,
          timestamp: new Date().toISOString(),
        }));
      } catch (sqsErr) {
        // Even this is non-fatal — log and continue
        console.error(JSON.stringify({
          level: 'ERROR',
          event: 'ses_retry_queue_failed',
          reason: sqsErr.message,
          timestamp: new Date().toISOString(),
        }));
      }
    }
    // Never re-throw — email failures must not break the primary action
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI profile scoring — degrade gracefully, queue SQS retry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls scoreProfileWithAI. If it times out or errors:
 *  - Returns { score: null, reasoning: null } so the application can still be saved.
 *  - Sets a flag `scoringPending: true` for the caller to write status = 'pending_score'.
 *  - Enqueues an SQS message for a retry in ~2 minutes.
 *
 * @returns {{ score: number|null, reasoning: string|null, scoringPending: boolean }}
 */
export async function scoreWithFallback(jobDescription, cvText, applicationId, jobId) {
  try {
    const { score, reasoning } = await scoreProfileWithAI(jobDescription, cvText);
    return { score, reasoning, scoringPending: false };
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'ai_scoring_failed',
      applicationId,
      jobId,
      reason: err.message,
      timestamp: new Date().toISOString(),
    }));

    if (SQS_SCORING_RETRY_QUEUE_URL) {
      try {
        await sqs.send(new SendMessageCommand({
          QueueUrl: SQS_SCORING_RETRY_QUEUE_URL,
          MessageBody: JSON.stringify({
            applicationId,
            jobId,
            jobDescription,
            cvText,
            retryAfter: Date.now() + 2 * 60 * 1000,
          }),
          DelaySeconds: 120, // 2 minutes
        }));
        console.log(JSON.stringify({
          level: 'INFO',
          event: 'scoring_retry_queued',
          applicationId,
          timestamp: new Date().toISOString(),
        }));
      } catch (sqsErr) {
        console.error(JSON.stringify({
          level: 'ERROR',
          event: 'scoring_retry_queue_failed',
          reason: sqsErr.message,
          timestamp: new Date().toISOString(),
        }));
      }
    }

    return { score: null, reasoning: null, scoringPending: true };
  }
}
