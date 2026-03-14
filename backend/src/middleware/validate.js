// validate.js — Zod request body validation middleware.
// Usage: router.post('/path', validate(someSchema), asyncHandler(async (req, res) => { ... }))
//
// On success  → req.validated holds the coerced, stripped data.
// On failure  → responds 400 with { code, errors: [{ field, message }] }
//               so the frontend can highlight multiple fields at once.

import { ERROR_CODES } from '../utils/errors.js';

/**
 * Returns an Express middleware that validates req.body against a Zod schema.
 * All Zod issues are mapped to { field, message } and returned in a single
 * response — the frontend receives every broken field in one round-trip.
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.errors.map(e => ({
        field:   e.path.length ? e.path.join('.') : 'body',
        message: e.message,
      }));
      return res.status(400).json({ code: ERROR_CODES.VALIDATION_ERROR, errors });
    }
    req.validated = result.data;
    next();
  };
}
