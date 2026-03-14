// In-app notification creation and status-change notification dispatch.

import { SendEmailCommand } from '@aws-sdk/client-ses';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { NOTIFICATIONS_TABLE, JOBS_TABLE, SES_FROM_EMAIL } from './clients.js';
import { ddbSend, sesSend } from './aws-wrappers.js';

export async function createNotification(userId, type, applicationId, jobId, title, body) {
  try {
    if (!userId) return;
    const now     = new Date().toISOString();
    const notifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    await ddbSend(new PutCommand({
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

export async function notifyStatusChange(newStatus, app) {
  const { applicationId, jobId, seekerId, recruiterId, candidateName, candidateEmail } = app;
  let jobTitle = app.jobTitle || null;
  if (!jobTitle && jobId) {
    try {
      const jr = await ddbSend(new QueryCommand({
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
    sesSend(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [n.sesTo] },
      Message: { Subject: { Data: n.sesSubject }, Body: { Text: { Data: n.sesBody } } },
    }), { recipient: n.sesTo, template: `status_${newStatus}` }).catch(() => {});
  }
}
