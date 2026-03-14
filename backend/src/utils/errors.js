// Standard AppError class and error code constants for the AI recruiter platform.

/**
 * Operational error that is safe to surface to clients.
 * Throw this instead of generic Error for any expected failure
 * (bad input, resource not found, auth failure, etc.).
 *
 * The global errorHandler middleware reads isOperational to decide whether
 * to forward err.message to the client or replace it with a generic string.
 */
export class AppError extends Error {
  /**
   * @param {string} message    - Human-readable message (will be sent to the client).
   * @param {number} statusCode - HTTP status code (4xx / 5xx).
   * @param {string} errorCode  - Machine-readable code from ERROR_CODES (e.g. 'JOB_NOT_FOUND').
   */
  constructor(message, statusCode, errorCode) {
    super(message);
    this.name          = 'AppError';
    this.statusCode    = statusCode;
    this.errorCode     = errorCode || 'INTERNAL_ERROR';
    this.isOperational = true; // distinguishes expected errors from programming bugs
  }
}

/**
 * Canonical error codes used across the platform.
 * Import these constants instead of bare strings so that client-side code,
 * server-side handlers, tests, and documentation all reference the same value.
 */
export const ERROR_CODES = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  INVALID_TOKEN:   'INVALID_TOKEN',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  UNAUTHORIZED:    'UNAUTHORIZED',

  // ── Application ───────────────────────────────────────────────────────────
  APPLICATION_NOT_FOUND: 'APPLICATION_NOT_FOUND',
  ALREADY_APPLIED:       'ALREADY_APPLIED',
  APPLICATION_CLOSED:    'APPLICATION_CLOSED',

  // ── Interview ─────────────────────────────────────────────────────────────
  TOKEN_EXPIRED:              'TOKEN_EXPIRED',
  TOKEN_INVALID:              'TOKEN_INVALID',
  TOKEN_ALREADY_USED:         'TOKEN_ALREADY_USED',
  INTERVIEW_ALREADY_COMPLETE: 'INTERVIEW_ALREADY_COMPLETE',

  // ── Job ───────────────────────────────────────────────────────────────────
  JOB_NOT_FOUND:     'JOB_NOT_FOUND',
  JOB_CLOSED:        'JOB_CLOSED',
  JOB_LIMIT_REACHED: 'JOB_LIMIT_REACHED',

  // ── General ───────────────────────────────────────────────────────────────
  VALIDATION_ERROR:       'VALIDATION_ERROR',
  UPLOAD_FAILED:          'UPLOAD_FAILED',
  AI_SERVICE_UNAVAILABLE: 'AI_SERVICE_UNAVAILABLE',
  DATABASE_UNAVAILABLE:   'DATABASE_UNAVAILABLE',
  SCORING_UNAVAILABLE:    'SCORING_UNAVAILABLE',
};
