// backend/src/interview-engine.js
// Interview orchestration — ties together session state, AI decisions, and question flow

import { loadState, saveState } from "./session-store.js";
import { callBedrockPolicy, generateQuestionsFromJD, generateCandidateSummary } from "./bedrock-client.js";
import { CLOSING, LAST_QUESTION } from "./prompts.js";

export { generateCandidateSummary };

export async function processTranscript({ meetingId, attendeeId, transcriptText, isInit = false, jobDescription, candidateName, customQuestions }) {
  const tag = `[${meetingId}/${attendeeId}]`;
  const state = (await loadState(meetingId, attendeeId)) || { qIndex: 0, started: false, done: false };

  if (isInit || !state.started) {
    console.log(`${tag} Init — candidate: "${candidateName || 'unknown'}", hasJD: ${!!jobDescription}, customQs: ${customQuestions?.length || 0}`);
    state.started = true;
    state.qIndex = 0;
    state.done = false;
    state.history = [];
    state.startedAt = new Date().toISOString();

    let midQs;
    if (customQuestions && Array.isArray(customQuestions) && customQuestions.length > 0) {
      midQs = customQuestions;
      console.log(`${tag} Using ${midQs.length} custom question(s) as middle questions`);
    } else {
      const jd = jobDescription || 'General professional role — assess motivation, work style, strengths, and relevant experience';
      console.log(`${tag} ${jobDescription ? "Generating JD-specific middle questions..." : "No CV/JD — generating generic middle questions..."}`);
      midQs = await generateQuestionsFromJD(jd, candidateName || "the candidate") || [];
      console.log(`${tag} Generated ${midQs.length} middle question(s) from AI`);
    }
    const firstQuestion = `Hi ${candidateName || 'there'}! Thanks for joining today — how are you doing?`;
    state.questions = [firstQuestion, ...midQs, LAST_QUESTION];
    state.jobDescription = jobDescription || null;

    console.log(`${tag} Interview ready — ${state.questions.length} questions total (1 greeting + ${midQs.length} middle + 1 closing)`);
    await saveState(meetingId, attendeeId, state);
    return { spokenText: state.questions[0], done: false, qIndex: 0 };
  }

  if (state.done) {
    console.log(`${tag} Already completed — returning closing`);
    return { spokenText: CLOSING, done: true, qIndex: state.qIndex };
  }

  const questions = state.questions || [];

  if (!transcriptText || transcriptText.trim() === "") {
    console.warn(`${tag} Empty transcript at Q${state.qIndex + 1}/${questions.length} — repeating question`);
    return { spokenText: `Sorry, I didn't catch that. ${questions[state.qIndex]}`, done: false, qIndex: state.qIndex };
  }

  const currentQuestion = questions[state.qIndex];
  console.log(`${tag} Q${state.qIndex + 1}/${questions.length} — candidate said: "${transcriptText.slice(0, 80)}${transcriptText.length > 80 ? '…' : ''}"`);

  let decision;
  try {
    decision = await callBedrockPolicy({ userText: transcriptText, currentQuestion });
    console.log(`${tag} Bedrock decision: action=${decision.action}, advance=${decision.advance}`);
  } catch (error) {
    console.error(`${tag} Bedrock error at Q${state.qIndex + 1}:`, error.message);
    decision = { action: "REPEAT", advance: false, spoken_reply: "" };
  }

  if (decision.advance) state.qIndex += 1;

  if (state.qIndex >= questions.length) {
    state.done = true;
    state.history = state.history || [];
    state.history.push({ q: currentQuestion, a: transcriptText, reply: CLOSING, t: new Date().toISOString() });
    await saveState(meetingId, attendeeId, state);
    console.log(`${tag} Interview complete after ${state.history.length} turn(s)`);
    return { spokenText: CLOSING, done: true, qIndex: state.qIndex };
  }

  const nextQuestion = questions[state.qIndex];
  let spoken = decision.spoken_reply || "";
  if (decision.advance) {
    spoken = spoken ? `${spoken} ${nextQuestion}` : nextQuestion;
    console.log(`${tag} Advanced to Q${state.qIndex + 1}/${questions.length}`);
  } else {
    if (!spoken.includes("?")) spoken = `${spoken} ${currentQuestion}`.trim();
    console.log(`${tag} Staying on Q${state.qIndex + 1}/${questions.length} (follow-up/repeat)`);
  }

  state.history = state.history || [];
  state.history.push({ q: currentQuestion, a: transcriptText, reply: spoken, t: new Date().toISOString() });
  await saveState(meetingId, attendeeId, state);

  return { spokenText: spoken, done: false, qIndex: state.qIndex };
}

