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
  return res.Item || null;
}

export async function saveState(meetingId, attendeeId, state) {
  const { pk, sk } = makeKeys(meetingId, attendeeId);
  await ddb.send(new PutCommand({
    TableName: SESSION_TABLE,
    Item: { pk, sk, updatedAt: Date.now(), ...state },
  }));
}
