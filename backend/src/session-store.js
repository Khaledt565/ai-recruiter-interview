// backend/src/session-store.js
// DynamoDB session read/write — knows nothing about AI or interview logic

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "eu-central-1";
const SESSION_TABLE = process.env.SESSION_TABLE || "InterviewSessions";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const makeKeys = (meetingId, attendeeId) => ({
  pk: `MEETING#${meetingId}`,
  sk: `ATTENDEE#${attendeeId}`,
});

export async function loadState(meetingId, attendeeId) {
  const { pk, sk } = makeKeys(meetingId, attendeeId);
  const res = await ddb.send(new GetCommand({ TableName: SESSION_TABLE, Key: { pk, sk } }));
  const found = !!res.Item;
  console.log(`[SessionStore] loadState [${meetingId}/${attendeeId}] — ${found ? `found (qIndex=${res.Item.qIndex}, done=${res.Item.done})` : 'not found (new session)'}`);
  return res.Item || null;
}

export async function saveState(meetingId, attendeeId, state) {
  const { pk, sk } = makeKeys(meetingId, attendeeId);
  await ddb.send(new PutCommand({
    TableName: SESSION_TABLE,
    Item: { pk, sk, updatedAt: Date.now(), ...state },
  }));
  console.log(`[SessionStore] saveState [${meetingId}/${attendeeId}] — qIndex=${state.qIndex}, done=${state.done}, turns=${(state.history || []).length}`);
}
