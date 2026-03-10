// backend/src/bedrock-client.js
// All AWS Bedrock / Claude AI calls — knows nothing about sessions or HTTP

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { SYSTEM_PROMPT, BEDROCK_MODEL_ID, CLOSING } from "./prompts.js";

const REGION = process.env.AWS_REGION || "eu-central-1";
const bedrock = new BedrockRuntimeClient({ region: REGION });

function extractJsonText(text) {
  return text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
}

function parseBedrockResponse(resp) {
  const raw = Buffer.from(resp.body).toString("utf-8");
  const parsed = JSON.parse(raw);
  return parsed?.content?.find((c) => c.type === "text")?.text?.trim() || "";
}

// Decide how to respond to a candidate's answer
export async function callBedrockPolicy({ userText, currentQuestion }) {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 220,
    temperature: 0.2,
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [{ type: "text", text: JSON.stringify({ currentQuestion, candidateSaid: userText }) }],
    }],
  };
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  }));
  return JSON.parse(parseBedrockResponse(resp) || "{}");
}

// Generate 5 role-specific questions from a job description or CV
export async function generateQuestionsFromJD(jobDescription, candidateName) {
  try {
    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 700,
      temperature: 0.3,
      messages: [{
        role: "user",
        content: `Generate exactly 5 conversational voice interview questions for ${candidateName} based on this job description:\n\n${jobDescription}\n\nRules:\n- Question 1 must be a warm greeting and icebreaker (e.g. "Hi ${candidateName}, thanks for joining! How are you doing today?")\n- Questions 2-5 should probe role-specific skills, motivation, experience, salary expectations, and invite candidate questions\n- Each question must be short (1-2 sentences), spoken naturally as voice dialogue\n- Return ONLY a JSON array of 5 strings, no other text`,
      }],
    };
    const resp = await bedrock.send(new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    }));
    const text = extractJsonText(parseBedrockResponse(resp) || "[]");
    const questions = JSON.parse(text);
    if (Array.isArray(questions) && questions.length === 5) return questions;
  } catch (err) {
    console.error("Failed to generate dynamic questions:", err.message);
  }
  return null;
}

// Generate 3 suggested questions from a CV/JD for the recruiter to pick from
export async function suggestQuestionsFromCV(text) {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 600,
    temperature: 0.4,
    messages: [{
      role: "user",
      content: `Based on this CV or job description, generate exactly 3 targeted interview questions that probe the candidate's specific experience and suitability for the role.\n\n${text.slice(0, 4000)}\n\nRules:\n- Each question must be short (1-2 sentences), conversational, and suitable for a voice interview\n- Focus on specific skills, experience, or notable aspects visible in the CV/JD\n- Do NOT include a generic greeting or icebreaker\n- Return ONLY a JSON array of exactly 3 strings, no other text`,
    }],
  };
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  }));
  const cleaned = extractJsonText(parseBedrockResponse(resp) || "[]");
  const questions = JSON.parse(cleaned);
  if (!Array.isArray(questions) || !questions.length) throw new Error("Invalid response format");
  return questions.slice(0, 3);
}

// Generate an AI assessment after the interview completes
export async function generateCandidateSummary(history, candidateName, jobDescription) {
  if (!history || history.length === 0) return null;
  const transcript = history.map((h, i) => `Q${i + 1}: ${h.q}\nCandidate: ${h.a}`).join("\n\n");
  const jobContext = jobDescription ? `Job Description:\n${jobDescription}\n\n` : "";
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 800,
    temperature: 0.2,
    messages: [{
      role: "user",
      content: `You are a recruiter reviewing a completed interview. Provide an objective candidate assessment.\n\n${jobContext}Candidate: ${candidateName}\n\nInterview Transcript:\n${transcript}\n\nReturn ONLY valid JSON with these exact keys:\n- summary: string (2-3 sentence overall assessment)\n- strengths: array of exactly 3 strings\n- concerns: array of 0-3 strings\n- recommendation: one of "Strong Yes", "Yes", "Maybe", "No"\n- score: integer 1-10`,
    }],
  };
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  }));
  const text = extractJsonText(parseBedrockResponse(resp) || "{}");
  return JSON.parse(text);
}
