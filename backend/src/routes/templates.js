// Question template routes (GET /question-templates, POST /question-templates).

import { Router } from 'express';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, QUESTION_TEMPLATES_TABLE } from '../utils/clients.js';
import { requireAuth } from '../utils/auth.js';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: QUESTION_TEMPLATES_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `RECRUITER#${req.recruiterEmail}` },
    }));
    res.json({ templates: result.Items || [] });
  } catch (error) {
    console.error('Error listing question templates:', error);
    res.status(500).json({ error: 'Failed to list question templates' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, questions } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: 'questions must be a non-empty array' });
    }
    const cleanedQuestions = questions.map(q => String(q).trim()).filter(Boolean).slice(0, 10);
    if (!cleanedQuestions.length) {
      return res.status(400).json({ error: 'No valid questions provided' });
    }

    const templateId = `tpl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: QUESTION_TEMPLATES_TABLE,
      Item: {
        pk: `RECRUITER#${req.recruiterEmail}`,
        sk: `TEMPLATE#${templateId}`,
        templateId,
        recruiterId: req.recruiterEmail,
        name: name.trim(),
        questions: cleanedQuestions,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      },
    }));
    res.status(201).json({ templateId, name: name.trim() });
  } catch (error) {
    console.error('Error creating question template:', error);
    res.status(500).json({ error: 'Failed to create question template' });
  }
});

export default router;
