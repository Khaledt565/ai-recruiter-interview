// Recruiter job management routes (GET /jobs, POST /jobs)
// and public job browsing routes (GET /public/jobs, GET /public/jobs/:jobId).

import { Router }  from 'express';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, JOBS_TABLE, QUESTION_TEMPLATES_TABLE } from '../utils/clients.js';
import { requireAuth } from '../utils/auth.js';

// ── Recruiter routes — mount at /jobs ─────────────────────────────────────────
const jobsRouter = Router();

jobsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const result = await ddb.send(new QueryCommand({
      TableName: JOBS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `RECRUITER#${req.recruiterEmail}` },
      ScanIndexForward: false,
    }));
    res.json({ jobs: result.Items || [] });
  } catch (error) {
    console.error('Error listing jobs:', error);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

jobsRouter.post('/', requireAuth, async (req, res) => {
  try {
    const {
      title, description, requirements, location, employmentType,
      salaryMin, salaryMax, salaryCurrency,
      scoreThreshold, recommendationThreshold,
      interviewMode, questionTemplateId, customQuestions, status,
    } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'description is required' });
    }
    if (typeof description === 'string' && description.length > 30000) {
      return res.status(400).json({ error: 'description is too long' });
    }

    const validStatuses = ['draft', 'open', 'paused', 'closed'];
    const validModes    = ['auto', 'template', 'custom'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    if (interviewMode && !validModes.includes(interviewMode)) {
      return res.status(400).json({ error: 'Invalid interviewMode' });
    }
    if (Array.isArray(customQuestions) && customQuestions.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 custom questions' });
    }

    const jobId    = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now      = new Date().toISOString();
    const jobStatus = validStatuses.includes(status) ? status : 'draft';
    const mode      = validModes.includes(interviewMode) ? interviewMode : 'auto';

    await ddb.send(new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        pk: `RECRUITER#${req.recruiterEmail}`,
        sk: `JOB#${jobId}`,
        jobId,
        recruiterId: req.recruiterEmail,
        title: title.trim(),
        description: description.trim(),
        requirements: Array.isArray(requirements)
          ? requirements.map(r => String(r).trim()).filter(Boolean)
          : [],
        location: location ? String(location).trim() : null,
        employmentType: ['full-time', 'part-time', 'contract'].includes(employmentType) ? employmentType : 'full-time',
        salaryRange: (salaryMin != null || salaryMax != null) ? {
          min: typeof salaryMin === 'number' ? salaryMin : null,
          max: typeof salaryMax === 'number' ? salaryMax : null,
          currency: ['GBP', 'USD', 'EUR'].includes(salaryCurrency) ? salaryCurrency : 'GBP',
        } : null,
        scoreThreshold: typeof scoreThreshold === 'number'
          ? Math.min(100, Math.max(0, Math.round(scoreThreshold))) : 65,
        recommendationThreshold: typeof recommendationThreshold === 'number'
          ? Math.min(100, Math.max(0, Math.round(recommendationThreshold))) : 75,
        interviewMode: mode,
        questionTemplateId: mode === 'template' ? (questionTemplateId || null) : null,
        customQuestions: mode === 'custom' && Array.isArray(customQuestions)
          ? customQuestions.map(q => String(q).trim()).filter(Boolean)
          : null,
        status: jobStatus,
        createdAt: now,
        updatedAt: now,
      },
    }));

    console.log(`[Jobs] Created job "${title.trim()}" (${jobId}) status=${jobStatus} by ${req.recruiterEmail}`);
    res.status(201).json({ jobId, status: jobStatus });
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// ── Public routes — mount at /public/jobs ─────────────────────────────────────
export const publicJobsRouter = Router();

publicJobsRouter.get('/', async (req, res) => {
  try {
    const { search, location, employmentType } = req.query;
    const result = await ddb.send(new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: 'JobsByStatus',
      KeyConditionExpression: '#st = :st',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':st': 'open' },
    }));
    let jobs = result.Items || [];

    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim().toLowerCase();
      jobs = jobs.filter(j =>
        (j.title || '').toLowerCase().includes(q) ||
        (j.description || '').toLowerCase().includes(q),
      );
    }
    if (location && typeof location === 'string' && location.trim()) {
      const loc = location.trim().toLowerCase();
      jobs = jobs.filter(j => (j.location || '').toLowerCase().includes(loc));
    }
    if (employmentType && typeof employmentType === 'string') {
      jobs = jobs.filter(j => j.employmentType === employmentType);
    }

    const publicJobs = jobs.map(j => ({
      jobId: j.jobId,
      title: j.title,
      location: j.location,
      employmentType: j.employmentType,
      salaryRange: j.salaryRange,
      requirements: j.requirements,
      createdAt: j.createdAt,
      description: (j.description || '').substring(0, 500),
    }));

    res.json({ jobs: publicJobs });
  } catch (error) {
    console.error('Error listing public jobs:', error);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

publicJobsRouter.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!jobId || typeof jobId !== 'string' || jobId.length > 100) {
      return res.status(400).json({ error: 'Invalid job ID' });
    }
    const result = await ddb.send(new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: 'JobsByJobId',
      KeyConditionExpression: 'jobId = :jid',
      ExpressionAttributeValues: { ':jid': jobId },
      Limit: 1,
    }));
    const job = result.Items && result.Items[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'open') return res.status(404).json({ error: 'Job not found' });

    res.json({
      jobId:          job.jobId,
      title:          job.title,
      description:    job.description,
      requirements:   job.requirements,
      location:       job.location,
      employmentType: job.employmentType,
      salaryRange:    job.salaryRange,
      interviewMode:  job.interviewMode,
      createdAt:      job.createdAt,
    });
  } catch (error) {
    console.error('Error fetching public job:', error);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

export default jobsRouter;
