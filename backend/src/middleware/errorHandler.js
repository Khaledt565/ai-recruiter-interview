// Global Express error handler and asyncHandler wrapper.
// Register errorHandler LAST in the Express middleware chain (after all routes).

import { AppError } from '../utils/errors.js';

/**
 * Wraps an async route handler so that any unhandled rejection is automatically
 * forwarded to Express's next(err) pipeline instead of crashing the process.
 *
 * Usage:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }));
 */
export const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Central error-handling middleware (4-argument signature required by Express).
 *
 * Behaviour:
 *  - Logs a structured JSON entry to stdout → forwarded to CloudWatch Logs.
 *    CloudWatch Logs Insights can query fields like errorCode, route, userId.
 *  - Returns a clean { success, errorCode, message } JSON response.
 *  - Never exposes stack traces or internal details to the client.
 *  - Operational AppErrors surface their message directly; all other errors
 *    receive a generic "unexpected error" message.
 */
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isOperational = err instanceof AppError && err.isOperational === true;
  const statusCode    = err.statusCode || 500;
  const errorCode     = err.errorCode  || 'INTERNAL_ERROR';

  // Structured log — CloudWatch Logs Insights can query these fields.
  const logEntry = {
    timestamp:  new Date().toISOString(),
    level:      statusCode >= 500 ? 'ERROR' : 'WARN',
    route:      `${req.method} ${req.path}`,
    userId:     req.recruiterEmail || req.seekerId || null,
    errorCode,
    message:    err.message,
    statusCode,
  };
  console.error(JSON.stringify(logEntry));

  // Non-operational (programmer) errors get a generic client message;
  // their real details were already logged above.
  const clientMessage = isOperational
    ? err.message
    : 'An unexpected error occurred. Please try again later.';

  res.status(statusCode).json({
    success:   false,
    errorCode,
    message:   clientMessage,
  });
}
