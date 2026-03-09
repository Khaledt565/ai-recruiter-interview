// backend/src/interview-engine.js
// Core interview logic - shared between Lambda and Fargate

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "eu-central-1";
const SESSION_TABLE = process.env.SESSION_TABLE || "InterviewSessions";
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-haiku-20240307-v1:0";

const bedrock = new BedrockRuntimeClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Interview script
const QUESTIONS = [
  "Hi! Thanks for joining today. Before we start — how are you doing right now?",
  "What made you interested in this company?",
  "Can you share a quick example of relevant experience you've had in this field?",
  "What salary range are you aiming for, and is it flexible?",
  "Do you have any questions for us that I can take back to the team?",
];

const CLOSING = "Thanks a lot — that was really helpful. We'll review everything and get back to you soon. Have a great day!";

const SYSTEM_PROMPT =
  "You are a voice recruiting interviewer. You must follow the interview script. " +
  "Rules: Keep replies short (max ~2 sentences). Ask only ONE question at a time. " +
  "If the candidate goes off-topic, answer briefly then restate the current question. " +
  "Return ONLY valid JSON with keys: action, spoken_reply, advance (true/false). " +
  "Allowed actions: ANSWER_AND_RETURN, FOLLOW_UP, NEXT, REPEAT.";

// DynamoDB helpers
const makeKeys = (meetingId, attendeeId) => ({
  pk: `MEETING#${meetingId}`,
  sk: `ATTENDEE#${attendeeId}`,
});

async function loadState(meetingId, attendeeId) {
  const { pk, sk } = makeKeys(meetingId, attendeeId);
  const res = await ddb.send(
    new GetCommand({
      TableName: SESSION_TABLE,
      Key: { pk, sk },
    })
  );
  return res.Item || null;
}

async function saveState(meetingId, attendeeId, state) {
  const { pk, sk } = makeKeys(meetingId, attendeeId);
  await ddb.send(
    new PutCommand({
      TableName: SESSION_TABLE,
      Item: { pk, sk, updatedAt: Date.now(), ...state },
    })
  );
}

async function callBedrockPolicy({ userText, currentQuestion }) {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 220,
    temperature: 0.2,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              currentQuestion,
              candidateSaid: userText,
            }),
          },
        ],
      },
    ],
  };

  const resp = await bedrock.send(
    new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    })
  );

  const raw = Buffer.from(resp.body).toString("utf-8");
  const parsed = JSON.parse(raw);
  const text = parsed?.content?.find((c) => c.type === "text")?.text?.trim() || "{}";
  return JSON.parse(text);
}

// Strip markdown code fences that Bedrock may wrap around JSON
function extractJsonText(text) {
  return text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
}

// Generate role-specific questions from a job description
async function generateQuestionsFromJD(jobDescription, candidateName) {
  try {
    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 700,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `Generate exactly 5 conversational voice interview questions for ${candidateName} based on this job description:\n\n${jobDescription}\n\nRules:\n- Question 1 must be a warm greeting and icebreaker (e.g. "Hi ${candidateName}, thanks for joining! How are you doing today?")\n- Questions 2-5 should probe role-specific skills, motivation, experience, salary expectations, and invite candidate questions\n- Each question must be short (1-2 sentences), spoken naturally as voice dialogue\n- Return ONLY a JSON array of 5 strings, no other text`,
        },
      ],
    };
    const resp = await bedrock.send(new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    }));
    const raw = Buffer.from(resp.body).toString("utf-8");
    const parsed = JSON.parse(raw);
    const text = extractJsonText(parsed?.content?.find((c) => c.type === "text")?.text?.trim() || "[]");
    const questions = JSON.parse(text);
    if (Array.isArray(questions) && questions.length === 5) return questions;
  } catch (err) {
    console.error("Failed to generate dynamic questions, using defaults:", err.message);
  }
  return QUESTIONS;
}

// Generate AI candidate assessment after interview completes
export async function generateCandidateSummary(history, candidateName, jobDescription) {
  if (!history || history.length === 0) return null;
  const transcript = history.map((h, i) => `Q${i + 1}: ${h.q}\nCandidate: ${h.a}`).join("\n\n");
  const jobContext = jobDescription ? `Job Description:\n${jobDescription}\n\n` : "";
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 800,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: `You are a recruiter reviewing a completed interview. Provide an objective candidate assessment.\n\n${jobContext}Candidate: ${candidateName}\n\nInterview Transcript:\n${transcript}\n\nReturn ONLY valid JSON with these exact keys:\n- summary: string (2-3 sentence overall assessment)\n- strengths: array of exactly 3 strings\n- concerns: array of 0-3 strings\n- recommendation: one of "Strong Yes", "Yes", "Maybe", "No"\n- score: integer 1-10`,
      },
    ],
  };
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  }));
  const raw = Buffer.from(resp.body).toString("utf-8");
  const parsed = JSON.parse(raw);
  const text = extractJsonText(parsed?.content?.find((c) => c.type === "text")?.text?.trim() || "{}");
  return JSON.parse(text);
}

// Main interview processing logic
export async function processTranscript({ meetingId, attendeeId, transcriptText, isInit = false, jobDescription, candidateName }) {
  // Load or init state
  const state = (await loadState(meetingId, attendeeId)) || {
    qIndex: 0,
    started: false,
    done: false,
  };

  // Handle initialization
  if (isInit || !state.started) {
    state.started = true;
    state.qIndex = 0;
    state.done = false;
    state.history = [];
    state.startedAt = new Date().toISOString();
    if (jobDescription) {
      console.log("Generating JD-specific questions...");
      state.questions = await generateQuestionsFromJD(jobDescription, candidateName || "the candidate");
      state.jobDescription = jobDescription;
    }
    await saveState(meetingId, attendeeId, state);
    const questions = state.questions || QUESTIONS;
    return { spokenText: questions[0], done: false, qIndex: 0 };
  }

  // Check if already done
  if (state.done) {
    return { spokenText: CLOSING, done: true, qIndex: state.qIndex };
  }

  const questions = state.questions || QUESTIONS;

  // Handle empty transcript
  if (!transcriptText || transcriptText.trim() === "") {
    return {
      spokenText: `Sorry, I didn't catch that. ${questions[state.qIndex]}`,
      done: false,
      qIndex: state.qIndex,
    };
  }

  const currentQuestion = questions[state.qIndex];

  // Call AI policy
  let decision;
  try {
    decision = await callBedrockPolicy({
      userText: transcriptText,
      currentQuestion,
    });
  } catch (error) {
    console.error("Bedrock error:", error);
    decision = { action: "REPEAT", advance: false, spoken_reply: "" };
  }

  // Advance if needed
  if (decision.advance) state.qIndex += 1;

  // Check if done
  if (state.qIndex >= questions.length) {
    state.done = true;
    state.history = state.history || [];
    state.history.push({
      q: currentQuestion,
      a: transcriptText,
      reply: CLOSING,
      t: new Date().toISOString(),
    });
    await saveState(meetingId, attendeeId, state);
    return { spokenText: CLOSING, done: true, qIndex: state.qIndex };
  }

  // Build response
  const nextQuestion = questions[state.qIndex];
  let spoken = decision.spoken_reply || "";

  if (decision.advance) {
    spoken = spoken ? `${spoken} ${nextQuestion}` : nextQuestion;
  } else if (!spoken.includes("?")) {
    spoken = `${spoken} ${currentQuestion}`.trim();
  }

  // Save conversation history entry
  state.history = state.history || [];
  state.history.push({
    q: currentQuestion,
    a: transcriptText,
    reply: spoken,
    t: new Date().toISOString(),
  });

  await saveState(meetingId, attendeeId, state);

  return { spokenText: spoken, done: false, qIndex: state.qIndex };
}

export { QUESTIONS, CLOSING };
