// Zod schemas for all validated API endpoints.
// Import the specific schema you need in the relevant route file.

import { z } from 'zod';

// ── POST /seeker/auth/signup ──────────────────────────────────────────────────
export const signupSchema = z.object({
  email: z.string().email('Must be a valid email address'),
  // pragma: allowlist secret
  password: z.string()
    .min(8,  'Password must be at least 8 characters')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  role: z.enum(['recruiter', 'seeker'], {
    errorMap: () => ({ message: "Role must be 'recruiter' or 'seeker'" }),
  }),
  fullName: z.string()
    .min(1,   'Full name is required')
    .max(100, 'Full name must be 100 characters or fewer')
    .trim(),
});

// ── POST /jobs ────────────────────────────────────────────────────────────────
export const createJobSchema = z.object({
  title: z.string()
    .min(1,   'Title is required')
    .max(120, 'Title must be 120 characters or fewer')
    .trim(),
  description: z.string()
    .min(50,   'Description must be at least 50 characters')
    .max(5000, 'Description must be 5,000 characters or fewer'),
  scoreThreshold: z.number()
    .min(0,   'scoreThreshold must be between 0 and 100')
    .max(100, 'scoreThreshold must be between 0 and 100')
    .optional(),
  recommendationThreshold: z.number()
    .min(0,   'recommendationThreshold must be between 0 and 100')
    .max(100, 'recommendationThreshold must be between 0 and 100')
    .optional(),
  interviewMode:     z.enum(['auto', 'template', 'custom']).optional(),
  questionTemplateId: z.string().optional(),
  customQuestions: z.array(
    z.string().max(500, 'Each question must be 500 characters or fewer'),
  ).optional(),
  // Pass-through fields validated loosely (business rules enforce them downstream)
  requirements:   z.any().optional(),
  location:       z.string().max(200).optional(),
  employmentType: z.string().optional(),
  salaryMin:      z.number().optional(),
  salaryMax:      z.number().optional(),
  salaryCurrency: z.string().optional(),
  status:         z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.interviewMode === 'template' && !data.questionTemplateId) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      path:    ['questionTemplateId'],
      message: 'questionTemplateId is required when interviewMode is "template"',
    });
  }
  if (data.interviewMode === 'custom') {
    if (!Array.isArray(data.customQuestions) || data.customQuestions.length < 3) {
      ctx.addIssue({
        code:    z.ZodIssueCode.custom,
        path:    ['customQuestions'],
        message: 'At least 3 questions are required when interviewMode is "custom"',
      });
    }
  }
  if (
    data.scoreThreshold             !== undefined &&
    data.recommendationThreshold    !== undefined &&
    data.recommendationThreshold < data.scoreThreshold
  ) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      path:    ['recommendationThreshold'],
      message: 'recommendationThreshold must be greater than or equal to scoreThreshold',
    });
  }
});

// ── POST /applications ────────────────────────────────────────────────────────
export const createApplicationSchema = z.object({
  jobId:          z.string().min(1, 'jobId is required').max(100),
  seekerId:       z.string().min(1, 'seekerId is required').max(100),
  candidateName:  z.string().min(1, 'candidateName is required').max(200),
  candidateEmail: z.string().email('candidateEmail must be a valid email address'),
  cvText:         z.string()
    .min(1,     'cvText is required')
    .max(20000, 'cvText must be under 20,000 characters'),
  coverLetter: z.string()
    .min(50,   'Cover letter must be at least 50 characters')
    .max(3000, 'Cover letter must be 3,000 characters or fewer'),
});

// ── POST /applications/:id/messages ──────────────────────────────────────────
export const createMessageSchema = z.object({
  body: z.string()
    .min(1,    'Message body is required')
    .max(2000, 'Message must be 2,000 characters or fewer')
    .trim(),
});

// ── PATCH /applications/:id/status ───────────────────────────────────────────
const PIPELINE_STATUSES = [
  'applied', 'interview_invited', 'ai_interview_complete', 'recommended',
  'shortlisted', 'human_interview', 'offered', 'hired', 'rejected',
];

export const updateStatusSchema = z.object({
  status: z.enum(PIPELINE_STATUSES, {
    errorMap: () => ({ message: `status must be one of: ${PIPELINE_STATUSES.join(', ')}` }),
  }),
  jobId: z.string().min(1, 'jobId is required'),
});

/**
 * Legal forward-only status transition map.
 * Keys are the current (FROM) status; values are all valid next (TO) statuses.
 * Terminal states (hired, rejected) have an empty array — no transitions allowed.
 */
export const ALLOWED_TRANSITIONS = {
  pending_score:         ['applied', 'interview_invited', 'rejected'],
  applied:               ['interview_invited', 'shortlisted', 'rejected'],
  interview_invited:     ['ai_interview_complete', 'shortlisted', 'rejected'],
  ai_interview_complete: ['recommended', 'shortlisted', 'rejected'],
  recommended:           ['shortlisted', 'human_interview', 'offered', 'rejected'],
  shortlisted:           ['human_interview', 'offered', 'rejected'],
  human_interview:       ['offered', 'rejected'],
  offered:               ['hired', 'rejected'],
  hired:                 [],
  rejected:              [],
};
