# AI Recruiter Interview — Backend

> Express + Node.js API running on AWS ECS Fargate.
> Handles job posting, candidate applications, AI scoring, AI voice interviews, recruiter pipeline management, messaging, and notifications.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Structural Map](#structural-map)
3. [File Structure](#file-structure)
4. [Request Flow — Full Lifecycle](#request-flow--full-lifecycle)
5. [Route Reference](#route-reference)
6. [Authentication](#authentication)
7. [AI Interview Pipeline](#ai-interview-pipeline)
8. [DynamoDB Tables](#dynamodb-tables)
9. [AWS Services](#aws-services)
10. [Environment Variables](#environment-variables)
11. [Running Locally](#running-locally)
12. [Testing](#testing)
13. [Error Handling](#error-handling)

---

## Architecture Overview

```
Browser / Frontend (CloudFront S3)
        │
        │  HTTPS + WSS
        ▼
┌──────────────────────────────────┐
│         Express Server           │  ECS Fargate (port 8080)
│  ┌──────────┐  ┌──────────────┐  │
│  │  Routes   │  │  WebSocket   │  │
│  │  (REST)   │  │  Server (ws) │  │
│  └─────┬────┘  └──────┬───────┘  │
│        │              │          │
│  ┌─────▼──────────────▼───────┐  │
│  │       Core Modules          │  │
│  │  interview-engine.js        │  │
│  │  bedrock-client.js          │  │
│  │  session-store.js           │  │
│  └─────────────┬───────────────┘  │
└────────────────┼──────────────────┘
                 │
     ┌───────────┼───────────────┐
     ▼           ▼               ▼
  DynamoDB     Bedrock          S3
  (8 tables)  (Claude Haiku)   (CV files)
                 │
     ┌───────────┼───────────┐
     ▼           ▼           ▼
   Polly        SES         SQS
  (TTS audio)  (email)   (retry queues)
```

---

## Structural Map

```
server.js
├── Middleware
│   ├── cors()
│   ├── express.json({ limit: '10mb' })
│   ├── rateLimit  ──────────────────── /interview, /applications (100 req/15min)
│   └── errorHandler  ───────────────── catch-all, last in chain
│
├── Routes
│   ├── /jobs              ─── routes/jobs.js         [requireAuth]
│   ├── /public/jobs       ─── routes/jobs.js         [public]
│   ├── /applications      ─── routes/applications.js [mixed auth]
│   ├── /question-templates─── routes/templates.js    [requireAuth]
│   ├── /interview         ─── routes/interview.js    [mixed auth]
│   ├── /seeker/auth       ─── routes/seeker-auth.js  [public + limiter]
│   ├── /seeker            ─── routes/seeker-profile.js     [requireSeekerAuth]
│   ├── /seeker            ─── routes/seeker-applications.js[requireSeekerAuth]
│   ├── /notifications     ─── routes/notifications.js      [requireAuth]
│   └── /seeker/notifications ─ routes/notifications.js     [requireSeekerAuth]
│
└── WebSocket Server (ws)
    └── Message types: connect → init → transcript → end
        └── interview-engine.js ── processTranscript()
            └── bedrock-client.js ── callBedrockPolicy()
                                  ── generateQuestionsFromJD()

utils/
├── clients.js       ── All AWS SDK instances + table name constants
├── aws-wrappers.js  ── ddbSend (retry), s3Upload (timeout), sesSend (SQS fallback), scoreWithFallback
├── auth.js          ── HMAC link tokens, Cognito RS256, Seeker HS256, scrypt passwords
├── email.js         ── SES email senders (4 templates)
├── errors.js        ── AppError class + ERROR_CODES enum
├── notifications.js ── createNotification(), notifyStatusChange()
├── pipeline.js      ── Polly TTS, saveInterviewSnapshot(), finalizeInterviewPipeline()
└── schemas.js       ── Zod validation schemas + ALLOWED_TRANSITIONS DAG

middleware/
├── errorHandler.js  ── asyncHandler wrapper + global errorHandler
└── validate.js      ── Zod schema middleware → req.validated
```

---

## File Structure

```
backend/
├── src/
│   ├── server.js              Entry point. Mounts all routes, starts HTTP/HTTPS + WebSocket.
│   ├── interview-engine.js    Stateful Q&A turn machine. Loads/saves state via session-store.
│   ├── bedrock-client.js      All Claude (Bedrock) calls: policy, questions, scoring, reports.
│   ├── session-store.js       DynamoDB read/write for live interview state (MEETING# keys).
│   ├── prompts.js             System prompt, closing messages, Bedrock model ID constant.
│   │
│   ├── routes/
│   │   ├── jobs.js            Recruiter CRUD for jobs + public job board.
│   │   ├── applications.js    Application submission, pipeline status, reports, messaging.
│   │   ├── interview.js       Interview lifecycle: create, validate, process, transcript, archive.
│   │   ├── templates.js       Question template CRUD (recruiter-scoped).
│   │   ├── seeker-auth.js     Sign-up, login, forgot/reset password.
│   │   ├── seeker-profile.js  Profile read/write + CV upload to S3.
│   │   ├── seeker-applications.js  Seeker's own application list + messaging.
│   │   └── notifications.js   Read/mark-read for recruiter + seeker notifications.
│   │
│   ├── utils/
│   │   ├── clients.js         Single source of AWS clients and all env-var table names.
│   │   ├── aws-wrappers.js    Resilient wrappers with retry, timeout, and SQS fallback.
│   │   ├── auth.js            Token generation/verification, JWT middleware, password hashing.
│   │   ├── email.js           Four SES email templates (invite, complete, low-score, notify).
│   │   ├── errors.js          AppError class and ERROR_CODES constants.
│   │   ├── notifications.js   In-app notification writer + status-change email dispatch.
│   │   ├── pipeline.js        Post-interview: Polly TTS, S3 snapshot, scoring, report writing.
│   │   └── schemas.js         All Zod schemas and the status transition DAG.
│   │
│   └── middleware/
│       ├── errorHandler.js    asyncHandler() + global Express error handler.
│       └── validate.js        Middleware factory: validates req.body against a Zod schema.
│
├── package.json
└── Dockerfile
```

---

## Request Flow — Full Lifecycle

### A candidate applies and completes an AI interview

```
1. Seeker visits /public/jobs → jobs.js → DynamoDB Jobs table
2. Seeker submits form → POST /applications
      applications.js
        ├── Validates input (Zod + manual checks)
        ├── Fetches job from Jobs table (must be 'open')
        ├── scoreWithFallback() → bedrock-client.scoreProfileWithAI()
        │     └── Claude scores CV vs JD, returns 0-100 + reasoning
        ├── Writes Application record to DynamoDB
        ├── If score ≥ threshold:
        │   ├── Resolves interview questions (auto / template / custom)
        │   ├── Creates AI_SESSIONS_TABLE record
        │   ├── Creates SESSION_TABLE META record (interview metadata)
        │   ├── generateLinkToken(interviewId) → HMAC-SHA256
        │   ├── sendCandidateInvitationEmail → SES
        │   └── createNotification(seekerId, 'interview_invited')
        └── Returns { applicationId, interviewId, interviewLink }

3. Candidate opens interview link → browser calls GET /interview/validate/:id?token=...
      interview.js
        ├── verifyLinkToken() — timing-safe compare
        ├── Checks expiry, status (expired / completed / in_progress)
        ├── Resumes if partially complete (welcomeMessage with progress)
        └── Updates status → 'in_progress'

4. Browser opens WebSocket  ws://host  with { type: 'connect' }
      server.js WebSocket handler
        ├── connect  → store meetingId / attendeeId
        ├── init     → verifyLinkToken, load META, processTranscript(isInit=true)
        │               → interview-engine: build question list, return Q[0]
        │               → generateSpeechWithFallback → Polly MP3 → base64
        ├── transcript → processTranscript(text)
        │               → callBedrockPolicy(text, currentQuestion)
        │               → Claude returns { action, spoken_reply, advance }
        │               → update qIndex, save state to DynamoDB
        │               → generateSpeechWithFallback → audio response
        └── end / close → saveInterviewSnapshot → finalizeInterviewPipeline

5. finalizeInterviewPipeline (pipeline.js)
        ├── generateInterviewReport(history) → Claude → answerScores, summary, strengths, concerns
        ├── combinedScore = aiProfileScore×0.4 + aiInterviewScore×0.6
        ├── Writes InterviewReports record
        ├── Updates Application status → 'recommended' or 'ai_interview_complete'
        ├── sendInterviewCompleteNotification → SES to recruiter
        └── createNotification(recruiterEmail, 'interview_complete')

6. Recruiter logs in → GET /interview/sessions → sees candidate with score
7. Recruiter moves candidate → PATCH /applications/:id/status
        ├── validate(updateStatusSchema) — enforces ALLOWED_TRANSITIONS DAG
        ├── Updates DynamoDB
        └── notifyStatusChange → in-app + email to seeker
```

---

## Route Reference

### Public

| Method | Path                               | Description                                          |
| ------ | ---------------------------------- | ---------------------------------------------------- |
| GET    | `/health`                          | Health check (`{ status, timestamp, version }`)      |
| GET    | `/public/jobs`                     | List open jobs (filter by search / location / type)  |
| GET    | `/public/jobs/:jobId`              | Single open job detail                               |
| GET    | `/interview/validate/:interviewId` | Validate interview link token, check expiry & status |
| GET    | `/interview/result/:interviewId`   | Poll interview completion status                     |
| POST   | `/seeker/auth/signup`              | Register seeker account                              |
| POST   | `/seeker/auth/login`               | Login → `{ token, seeker }`                          |
| POST   | `/seeker/auth/forgot-password`     | Send password reset email                            |
| POST   | `/seeker/auth/reset-password`      | Set new password with reset token                    |

### Seeker (requires seeker JWT)

| Method | Path                                | Description                                     |
| ------ | ----------------------------------- | ----------------------------------------------- |
| GET    | `/seeker/profile`                   | Get own profile                                 |
| PUT    | `/seeker/profile`                   | Update profile fields                           |
| POST   | `/seeker/profile/cv`                | Upload CV (base64 → S3)                         |
| GET    | `/seeker/applications`              | List own applications (with job title/location) |
| GET    | `/seeker/applications/:id`          | Single application detail                       |
| POST   | `/seeker/applications/:id/withdraw` | Withdraw application                            |
| GET    | `/seeker/applications/:id/messages` | Message thread                                  |
| POST   | `/seeker/applications/:id/messages` | Send message to recruiter                       |
| GET    | `/seeker/notifications`             | List notifications                              |
| POST   | `/seeker/notifications/read-all`    | Mark all read                                   |
| POST   | `/seeker/notifications/:id/read`    | Mark one read                                   |

### Recruiter (requires Cognito JWT)

| Method | Path                           | Description                                |
| ------ | ------------------------------ | ------------------------------------------ |
| GET    | `/jobs`                        | List own job postings                      |
| POST   | `/jobs`                        | Create job posting                         |
| GET    | `/applications`                | List all applications for recruiter        |
| PATCH  | `/applications/:id/status`     | Move candidate through pipeline            |
| GET    | `/applications/:id/report`     | Full interview report + transcript         |
| GET    | `/applications/:id/messages`   | Message thread with candidate              |
| POST   | `/applications/:id/messages`   | Send message to candidate                  |
| GET    | `/question-templates`          | List own question templates                |
| POST   | `/question-templates`          | Create template (max 10 questions)         |
| GET    | `/interview/sessions`          | List all interview sessions                |
| POST   | `/interview/create`            | Manually create interview (no application) |
| POST   | `/interview/suggest-questions` | AI-generate questions from JD/CV text      |
| GET    | `/interview/transcript/:id`    | Full Q&A transcript                        |
| DELETE | `/interview/:id`               | Archive interview                          |
| POST   | `/interview/resend-invite/:id` | Resend invite email                        |
| POST   | `/interview/regenerate/:id`    | Reset + extend interview link 7 days       |
| GET    | `/notifications`               | List notifications                         |
| POST   | `/notifications/read-all`      | Mark all read                              |
| POST   | `/notifications/:id/read`      | Mark one read                              |

### Mixed auth (`requireAnyAuth` — seeker or recruiter)

| Method | Path                         | Description                            |
| ------ | ---------------------------- | -------------------------------------- |
| GET    | `/applications/:id/messages` | Either participant can read the thread |
| POST   | `/applications/:id/messages` | Either participant can send a message  |

### WebSocket (`ws://host`)

| Message type          | Direction     | Description                                               |
| --------------------- | ------------- | --------------------------------------------------------- |
| `connect`             | client→server | Register `meetingId` + `attendeeId`                       |
| `init`                | client→server | Start interview (token verified, first question returned) |
| `transcript`          | client→server | Submit answer text → receive next question                |
| `end`                 | client→server | Candidate ends early                                      |
| `response`            | server→client | `{ spokenText, audioBase64, textMode, done, qIndex }`     |
| `error`               | server→client | `{ error: string }`                                       |
| `connected` / `ended` | server→client | Acknowledgement frames                                    |

---

## Authentication

The system has **two separate auth flows** that coexist:

### Recruiter — AWS Cognito (RS256 JWT)

- Tokens issued by Cognito User Pool `eu-central-1_JbO8lhpi2`
- `requireAuth` middleware fetches public JWKS, verifies signature, extracts email → `req.recruiterEmail`
- Used on all `/jobs`, `/applications`, `/interview`, `/notifications` recruiter routes

### Seeker — Custom HS256 JWT

- Tokens issued by this server using `SEEKER_JWT_SECRET`
- `requireSeekerAuth` verifies with `jsonwebtoken`, extracts `{ seekerId, email }` → `req.seekerId` / `req.seekerEmail`
- Password stored as `scrypt(password, 16-byte random salt, keylen=64)` — never plain text
- Rate-limited: 20 attempts / 15 min per IP on all `/seeker/auth/*` endpoints

### Interview Link Tokens

- `generateLinkToken(interviewId)` = `HMAC-SHA256(LINK_SECRET, interviewId)` hex
- Verified with `crypto.timingSafeEqual` to prevent timing attacks
- Links expire after **7 days** (checked in `/interview/validate`)

### `requireAnyAuth`

Tries seeker HS256 first, falls back to Cognito RS256. Used on messaging endpoints so both parties can access the same thread with ownership checked afterward.

---

## AI Interview Pipeline

### Question source (priority order)

1. **Custom** — `job.customQuestions[]` (up to 10, set at job creation)
2. **Template** — `job.questionTemplateId` → fetch from `QuestionTemplates` table
3. **Auto** — `generateQuestionsFromJD(jobDescription)` → Claude generates 3 questions

Final question list structure:

```
[0] "Hi {name}! Thanks for joining today — how are you doing?"   ← icebreaker
[1..n] role-specific questions
[last] "Before we wrap up — do you have any questions for us?"   ← LAST_QUESTION
```

### Turn logic (`interview-engine.js`)

Each answer is evaluated by Claude via `callBedrockPolicy()`:

```json
{
  "action": "ANSWER_AND_RETURN | FOLLOW_UP | NEXT | REPEAT",
  "spoken_reply": "...",
  "advance": true | false
}
```

- `advance: true` → `qIndex++`, ask next question
- `advance: false` → stay on same question (e.g. off-topic, too short)
- When `qIndex >= questions.length` → interview complete, trigger pipeline

### Scoring

| Stage                      | Weight   | Source                                       |
| -------------------------- | -------- | -------------------------------------------- |
| Profile (CV vs JD)         | 40%      | `scoreProfileWithAI()` at application time   |
| Interview (answer quality) | 60%      | `generateInterviewReport()` after completion |
| **Combined score**         | **100%** | Used for `recommended` threshold check       |

Status after scoring:

- `combinedScore >= recommendationThreshold` → status `recommended`
- Otherwise → status `ai_interview_complete`

---

## DynamoDB Tables

| Table                     | Partition Key                         | Sort Key                                   | Purpose                                   |
| ------------------------- | ------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| `InterviewSessions`       | `pk` (`INTERVIEW#id` or `MEETING#id`) | `sk` (`META`, `HISTORY`, or `ATTENDEE#id`) | Interview metadata + live interview state |
| `Jobs-dev`                | `pk` (`RECRUITER#email`)              | `sk` (`JOB#id`)                            | Job postings                              |
| `Applications-dev`        | `pk` (`JOB#id`)                       | `sk` (`APPLICATION#id`)                    | Applications with AI scores               |
| `AIInterviewSessions-dev` | `pk` (`APPLICATION#id`)               | `sk` (`SESSION#id`)                        | Invite tokens + session tracking          |
| `QuestionTemplates-dev`   | `pk` (`RECRUITER#email`)              | `sk` (`TEMPLATE#id`)                       | Reusable question sets                    |
| `InterviewReports-dev`    | `pk` (`INTERVIEW#id`)                 | `sk` (`REPORT#id`)                         | Final AI-generated reports                |
| `Users-dev`               | `pk` (`USER#id`)                      | `sk` `PROFILE`                             | Seeker accounts                           |
| `Notifications-dev`       | `pk` (`USER#email_or_id`)             | `sk` (timestamp-based)                     | In-app notifications                      |
| `Messages-dev`            | `pk` (`APPLICATION#id`)               | `sk` (`MSG#timestamp#id`)                  | Recruiter ↔ seeker messages               |

Key GSIs:

- `Jobs`: `JobsByStatus` (status-based public listing), `JobsByJobId` (lookup by jobId)
- `Applications`: `ApplicationsByRecruiter` (recruiterId), `ApplicationById` (applicationId)
- `InterviewReports`: `ReportByApplication` (applicationId)
- `QuestionTemplates`: `TemplateById` (templateId)

---

## AWS Services

| Service                    | Usage                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------- |
| **DynamoDB**               | Primary datastore for all entities                                                      |
| **Bedrock (Claude Haiku)** | CV scoring, question generation, turn policy, interview reports, candidate summaries    |
| **Polly (neural Joanna)**  | Text-to-speech for interview questions — MP3 returned as base64                         |
| **S3**                     | CV file storage (`cvs/{seekerId}/{ts}.{ext}`), interview JSON snapshots, AES256 SSE     |
| **SES**                    | Transactional emails — invite, completion report, low-score alert, password reset       |
| **SQS**                    | Async retry queues for: email failures, AI scoring failures, report generation failures |
| **Cognito**                | Recruiter identity + JWT issuance                                                       |

---

## Environment Variables

| Variable                      | Default                                  | Description                                              |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `PORT`                        | `8080`                                   | Server port                                              |
| `AWS_REGION`                  | `eu-central-1`                           | AWS region for all clients                               |
| `SESSION_TABLE`               | `InterviewSessions`                      | Live interview state table                               |
| `JOBS_TABLE`                  | `Jobs-dev`                               | Jobs table                                               |
| `APPLICATIONS_TABLE`          | `Applications-dev`                       | Applications table                                       |
| `AI_SESSIONS_TABLE`           | `AIInterviewSessions-dev`                | AI session tracking                                      |
| `QUESTION_TEMPLATES_TABLE`    | `QuestionTemplates-dev`                  | Question templates                                       |
| `INTERVIEW_REPORTS_TABLE`     | `InterviewReports-dev`                   | Post-interview reports                                   |
| `USERS_TABLE`                 | `Users-dev`                              | Seeker accounts                                          |
| `NOTIFICATIONS_TABLE`         | `Notifications-dev`                      | Notifications                                            |
| `MESSAGES_TABLE`              | `Messages-dev`                           | Recruiter ↔ seeker messages                              |
| `S3_CV_BUCKET`                | `ai-recruiter-interviews-090605004529`   | CV + snapshot bucket                                     |
| `COGNITO_USER_POOL_ID`        | `eu-central-1_JbO8lhpi2`                 | Recruiter auth pool                                      |
| `SEEKER_JWT_SECRET`           | `seeker-dev-secret-change-in-prod`       | **Change in production**                                 |
| `LINK_SECRET`                 | `default-dev-secret-change-in-prod`      | HMAC key for interview tokens — **Change in production** |
| `SES_FROM_EMAIL`              | _(empty)_                                | Verified SES sender address                              |
| `FRONTEND_URL`                | `https://d5k7p6fyxagls.cloudfront.net`   | Used in email links                                      |
| `BEDROCK_MODEL_ID`            | `anthropic.claude-3-haiku-20240307-v1:0` | Claude model                                             |
| `SQS_EMAIL_RETRY_QUEUE_URL`   | _(empty)_                                | Email retry queue URL                                    |
| `SQS_SCORING_RETRY_QUEUE_URL` | _(empty)_                                | Scoring retry queue URL                                  |
| `SQS_REPORT_RETRY_QUEUE_URL`  | _(empty)_                                | Report generation retry queue URL                        |
| `USE_HTTPS`                   | `true` if certs exist                    | Set to `false` to force HTTP in dev                      |

---

## Running Locally

```bash
# Install dependencies
cd backend
npm install

# Start with hot-reload (HTTP mode by default without certs)
USE_HTTPS=false npm run dev

# Production start
npm start
```

The server will start on `http://0.0.0.0:8080`. WebSocket is on the same port.

For HTTPS locally, place certificates at:

- `backend/certs/server.crt`
- `backend/certs/server.key`

You'll need AWS credentials configured (e.g. via `~/.aws/credentials` or env vars) for DynamoDB, Bedrock, Polly, SES, and S3 to work.

---

## Testing

```bash
# Run all tests once
npm test

# Watch mode
npm run test:watch

# Coverage report (outputs to /coverage)
npm run test:coverage
```

Tests are written with **Vitest**. Key test files:

- `src/__tests__/interview-flow.integration.test.js` — end-to-end interview turn logic
- `src/services/__tests__/interview-service.test.js` — service unit tests
- `src/utils/__tests__/config.test.js` — config/env helper tests

---

## Error Handling

All route handlers are wrapped with `asyncHandler()` — any thrown error is forwarded to the global `errorHandler` middleware.

**Operational errors** (`AppError` with `isOperational: true`) return the exact message to the client:

```json
{
  "success": false,
  "errorCode": "INVALID_STATUS_TRANSITION",
  "message": "Cannot transition from 'hired' to 'applied'"
}
```

**Unexpected errors** return a generic message to avoid leaking internals:

```json
{
  "success": false,
  "errorCode": "INTERNAL_ERROR",
  "message": "An unexpected error occurred. Please try again later."
}
```

All errors are structured-logged to CloudWatch with `{ timestamp, level, route, userId, errorCode, message, statusCode }`.

**Resilience patterns:**

- DynamoDB: 3 retries with exponential backoff (200 → 400 → 800ms) on throttle/capacity errors
- S3 uploads: 30-second abort timeout
- SES email: fire-and-forget — failure logged and enqueued to SQS for retry, never throws
- AI scoring: `scoreWithFallback` returns `{ scoringPending: true }` on Bedrock failure, re-scores async via SQS
- Polly TTS: `generateSpeechWithFallback` returns `null` on failure — client falls back to text-mode
