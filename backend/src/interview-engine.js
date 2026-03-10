// backend/src/interview-engine.js
// Interview orchestration — ties together session state, AI decisions, and question flow

import { loadState, saveState } from "./session-store.js";
import { callBedrockPolicy, generateQuestionsFromJD, generateCandidateSummary } from "./bedrock-client.js";
import { CLOSING, LAST_QUESTION } from "./prompts.js";

export { generateCandidateSummary };

export async function processTranscript({ meetingId, attendeeId, transcriptText, isInit = false, jobDescription, candidateName, customQuestions }) {
  const state = (await loadState(meetingId, attendeeId)) || { qIndex: 0, started: false, done: false };

  if (isInit || !state.started) {
    state.started = true;
    state.qIndex = 0;
    state.done = false;
    state.history = [];
    state.startedAt = new Date().toISOString();

    let midQs;
    if (customQuestions && Array.isArray(customQuestions) && customQuestions.length > 0) {
      midQs = customQuestions;
    } else {
      const jd = jobDescription || 'General professional role — assess motivation, work style, strengths, and relevant experience';
      console.log(jobDescription ? "Generating JD-specific middle questions..." : "No CV/JD provided, generating generic middle questions...");
      midQs = await generateQuestionsFromJD(jd, candidateName || "the candidate") || [];
    }
    const firstQuestion = `Hi ${candidateName || 'there'}! Thanks for joining today — how are you doing?`;
    state.questions = [firstQuestion, ...midQs, LAST_QUESTION];
    state.jobDescription = jobDescription || null;

    await saveState(meetingId, attendeeId, state);
    return { spokenText: state.questions[0], done: false, qIndex: 0 };
  }

  if (state.done) {
    return { spokenText: CLOSING, done: true, qIndex: state.qIndex };
  }

  const questions = state.questions || [];

  if (!transcriptText || transcriptText.trim() === "") {
    return { spokenText: `Sorry, I didn't catch that. ${questions[state.qIndex]}`, done: false, qIndex: state.qIndex };
  }

  const currentQuestion = questions[state.qIndex];

  let decision;
  try {
    decision = await callBedrockPolicy({ userText: transcriptText, currentQuestion });
  } catch (error) {
    console.error("Bedrock error:", error);
    decision = { action: "REPEAT", advance: false, spoken_reply: "" };
  }

  if (decision.advance) state.qIndex += 1;

  if (state.qIndex >= questions.length) {
    state.done = true;
    state.history = state.history || [];
    state.history.push({ q: currentQuestion, a: transcriptText, reply: CLOSING, t: new Date().toISOString() });
    await saveState(meetingId, attendeeId, state);
    return { spokenText: CLOSING, done: true, qIndex: state.qIndex };
  }

  const nextQuestion = questions[state.qIndex];
  let spoken = decision.spoken_reply || "";
  if (decision.advance) {
    spoken = spoken ? `${spoken} ${nextQuestion}` : nextQuestion;
  } else if (!spoken.includes("?")) {
    spoken = `${spoken} ${currentQuestion}`.trim();
  }

  state.history = state.history || [];
  state.history.push({ q: currentQuestion, a: transcriptText, reply: spoken, t: new Date().toISOString() });
  await saveState(meetingId, attendeeId, state);

  return { spokenText: spoken, done: false, qIndex: state.qIndex };
}

