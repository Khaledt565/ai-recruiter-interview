// All outbound SES email functions.

import { SendEmailCommand } from '@aws-sdk/client-ses';
import { ses, SES_FROM_EMAIL } from './clients.js';

export async function sendCandidateInvitationEmail(candidateName, candidateEmail, interviewLink) {
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
      <p style="color:#374151;font-size:14px;line-height:1.7;margin:0 0 20px;">Click the button below to begin your interview. The AI interviewer will guide you through a series of questions — just speak naturally into your microphone.</p>
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
        Subject: { Data: `Your AI Interview is Ready — ${candidateName}` },
        Body: {
          Html: { Data: htmlBody },
          Text: { Data: `Hello ${candidateName},\n\nYou have been invited to an AI-powered interview.\n\nClick this link to begin:\n${interviewLink}\n\nThe link is valid for 7 days and can only be used once.\n\nGood luck!` },
        },
      },
    }));
    console.log(`✅ Invitation email sent to ${candidateEmail}`);
  } catch (err) {
    console.error('❌ Failed to send invitation email (non-fatal):', err.message);
  }
}

export async function sendRecruiterEmail(recruiterEmail, candidateName, summary, interviewId) {
  try {
    const rec = summary?.recommendation || 'N/A';
    const score = summary?.score != null ? `${summary.score}/10` : 'N/A';
    const summaryText = summary?.summary || 'No summary available.';
    const strengths = (summary?.strengths || []).map(s => `  • ${s}`).join('\n');
    const concerns = (summary?.concerns || []).map(c => `  • ${c}`).join('\n');

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
        Subject: { Data: `Interview Complete: ${candidateName} — ${rec}` },
        Body: { Text: { Data: bodyLines.join('\n') } },
      },
    }));
    console.log(`✅ Recruiter email sent to ${recruiterEmail}`);
  } catch (err) {
    console.error('❌ Failed to send recruiter email (non-fatal):', err.message);
  }
}

export async function sendRecruiterLowScoreEmail(recruiterEmail, candidateName, jobTitle, score, applicationId) {
  if (!SES_FROM_EMAIL || !recruiterEmail) return;
  try {
    await ses.send(new SendEmailCommand({
      Source: SES_FROM_EMAIL,
      Destination: { ToAddresses: [recruiterEmail] },
      Message: {
        Subject: { Data: `New Application: ${candidateName} — ${score}/100 (below threshold)` },
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
    console.log(`✅ Low-score recruiter notification sent to ${recruiterEmail}`);
  } catch (err) {
    console.error('❌ Failed to send low-score notification (non-fatal):', err.message);
  }
}

export async function sendInterviewCompleteNotification(recruiterEmail, candidateName, jobTitle, combinedScore, interviewId) {
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
