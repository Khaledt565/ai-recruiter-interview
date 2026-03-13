// Shared AWS client instances and environment constants.
// All other modules import from here — avoids creating multiple SDK clients.

import { PollyClient } from '@aws-sdk/client-polly';
import { S3Client } from '@aws-sdk/client-s3';
import { SESClient } from '@aws-sdk/client-ses';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const REGION                   = process.env.AWS_REGION                   || 'eu-central-1';
export const SESSION_TABLE            = process.env.SESSION_TABLE                || 'InterviewSessions';
export const JOBS_TABLE               = process.env.JOBS_TABLE                   || 'Jobs-dev';
export const APPLICATIONS_TABLE       = process.env.APPLICATIONS_TABLE           || 'Applications-dev';
export const AI_SESSIONS_TABLE        = process.env.AI_SESSIONS_TABLE            || 'AIInterviewSessions-dev';
export const QUESTION_TEMPLATES_TABLE = process.env.QUESTION_TEMPLATES_TABLE     || 'QuestionTemplates-dev';
export const INTERVIEW_REPORTS_TABLE  = process.env.INTERVIEW_REPORTS_TABLE      || 'InterviewReports-dev';
export const COGNITO_USER_POOL_ID     = process.env.COGNITO_USER_POOL_ID         || 'eu-central-1_JbO8lhpi2';
export const USERS_TABLE              = process.env.USERS_TABLE                  || 'Users-dev';
export const S3_CV_BUCKET             = process.env.S3_CV_BUCKET                 || 'ai-recruiter-interviews-090605004529';
export const SEEKER_JWT_SECRET        = process.env.SEEKER_JWT_SECRET            || 'seeker-dev-secret-change-in-prod';
export const NOTIFICATIONS_TABLE      = process.env.NOTIFICATIONS_TABLE          || 'Notifications-dev';
export const MESSAGES_TABLE           = process.env.MESSAGES_TABLE               || 'Messages-dev';
export const SES_FROM_EMAIL           = process.env.SES_FROM_EMAIL               || '';
export const LINK_SECRET              = process.env.LINK_SECRET                  || 'default-dev-secret-change-in-prod';
export const FRONTEND_URL             = process.env.FRONTEND_URL                 || 'https://d5k7p6fyxagls.cloudfront.net';

export const polly = new PollyClient({ region: REGION });
export const s3    = new S3Client({ region: REGION });
export const ses   = new SESClient({ region: REGION });
export const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
