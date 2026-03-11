const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3002;

// Multi-key support: API_KEYS=key1,key2,key3
// Backward compat: API_KEY=singlekey still works
const API_KEYS = new Set(
    (process.env.API_KEYS || process.env.API_KEY || '')
        .split(',')
        .map(k => k.trim())
        .filter(Boolean)
);

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' })); // large base64 images

// ============================================
// Supported Job Types — Schema-driven definitions
// Each type defines: label, description, input schema, output schema
// ============================================

const SUPPORTED_JOB_TYPES = {
    'flow_generate': {
        label: 'AI Image Generation',
        description: 'Generate AI images via Google Flow',
        input: {
            required: { prompt: 'string' },
            optional: { model: 'string', orientation: 'string', count: 'number' },
        },
        output: {
            imageBase64: 'string',
            imageUrls: 'string[]',
        },
    },
    'post_x': {
        label: 'Post to X/Twitter',
        description: 'Compose and post tweets with text + images',
        input: {
            required: { text: 'string' },
            optional: { mediaUrls: 'string[]' },
        },
        output: {
            message: 'string',
            postUrl: 'string',
        },
    },
    'post_facebook': {
        label: 'Post to Facebook',
        description: 'Post to personal profile or Facebook pages with media',
        input: {
            required: { text: 'string' },
            optional: { mediaUrls: 'string[]', target: 'string' },
        },
        output: {
            message: 'string',
            postUrl: 'string',
        },
    },
    'reply_facebook_comment': {
        label: 'Reply on Facebook',
        description: 'Reply to a post or specific comment on a Facebook group',
        input: {
            required: {
                postUrl: 'string',  // URL of the Facebook group post
                text: 'string',     // Reply text content
            },
            optional: {
                commentId: 'string', // Target comment id (omit to reply to the post itself)
            },
        },
        output: {
            message: 'string',
        },
    },
    'search_google': {
        label: 'Google Search',
        description: 'Search Google and return organic results scraped from the browser',
        input: {
            required: { query: 'string' },
            optional: { count: 'number', sort: 'string' },
        },
        output: {
            organic: 'object[]',
            peopleAlsoAsk: 'string[]',
            totalResultsText: 'string',
        },
    },
    'search_x': {
        label: 'X/Twitter Search',
        description: 'Search X.com and return tweets scraped from the browser',
        input: {
            required: { query: 'string' },
            optional: { count: 'number', sort: 'string' },
        },
        output: {
            tweets: 'object[]',
        },
    },
    'fetch_x_profile': {
        label: 'Fetch X Profile Tweets',
        description: 'Get latest tweets from a specific X/Twitter profile',
        input: {
            required: { profileUrl: 'string' },
            optional: { count: 'number', includeReplies: 'boolean' },
        },
        output: {
            handle: 'string',
            displayName: 'string',
            tweets: 'object[]',
        },
    },
};

// ============================================
// Schema Validation Helpers
// ============================================

function validateType(value, expectedType) {
    if (expectedType === 'string') return typeof value === 'string';
    if (expectedType === 'number') return typeof value === 'number';
    if (expectedType === 'boolean') return typeof value === 'boolean';
    if (expectedType === 'string[]') return Array.isArray(value) && value.every(v => typeof v === 'string');
    if (expectedType === 'number[]') return Array.isArray(value) && value.every(v => typeof v === 'number');
    if (expectedType === 'object') return typeof value === 'object' && !Array.isArray(value);
    if (expectedType === 'object[]') return Array.isArray(value);
    return true; // unknown type = accept
}

function validateJobInput(typeDef, body) {
    const errors = [];
    const payload = {};

    // Check required fields
    for (const [field, expectedType] of Object.entries(typeDef.input.required)) {
        const val = body[field];
        if (val === undefined || val === null || (typeof val === 'string' && !val.trim())) {
            errors.push(`${field} is required (${expectedType})`);
        } else if (!validateType(val, expectedType)) {
            errors.push(`${field} must be ${expectedType}`);
        } else {
            payload[field] = typeof val === 'string' ? val.trim() : val;
        }
    }

    // Check optional fields (validate type if present)
    if (typeDef.input.optional) {
        for (const [field, expectedType] of Object.entries(typeDef.input.optional)) {
            const val = body[field];
            if (val !== undefined && val !== null) {
                if (!validateType(val, expectedType)) {
                    errors.push(`${field} must be ${expectedType}`);
                } else {
                    payload[field] = typeof val === 'string' ? val.trim() : val;
                }
            }
        }
    }

    return { errors, payload };
}

// ============================================
// API Key Authentication + Per-Key Isolation
// ============================================

function authMiddleware(req, res, next) {
    // No keys configured = local dev, use shared namespace
    if (API_KEYS.size === 0) {
        req.apiKey = '__dev__';
        return next();
    }

    // Health endpoint is always public
    if (req.path === '/health') return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Missing API key. Use Authorization: Bearer <key>' });
    }

    const token = authHeader.replace('Bearer ', '');
    if (!API_KEYS.has(token)) {
        return res.status(403).json({ success: false, error: 'Invalid API key' });
    }

    // Attach validated key to request — used to isolate jobs & extensions
    req.apiKey = token;
    next();
}

app.use(authMiddleware);

// ============================================
// Per-Key Extension Registry (in-memory)
// connectedExtensions: Map<apiKey, Map<extId, ext>>
// ============================================

const connectedExtensions = new Map();

function getExtensionsForKey(apiKey) {
    if (!connectedExtensions.has(apiKey)) connectedExtensions.set(apiKey, new Map());
    return connectedExtensions.get(apiKey);
}

// POST /api/extensions/connect — Extension declares name + types it handles
app.post('/api/extensions/connect', (req, res) => {
    const { name, types } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Extension name is required' });
    }

    if (!types || !Array.isArray(types) || types.length === 0) {
        return res.status(400).json({ success: false, error: 'types must be a non-empty array of job type strings' });
    }

    // Validate all types exist in bridge
    const unsupported = types.filter(t => !SUPPORTED_JOB_TYPES[t]);
    if (unsupported.length > 0) {
        return res.status(400).json({
            success: false,
            error: `Unsupported job type(s): ${unsupported.join(', ')}. Available: ${Object.keys(SUPPORTED_JOB_TYPES).join(', ')}`,
        });
    }

    const exts = getExtensionsForKey(req.apiKey);
    const trimmedName = name.trim();

    // Remove old connections with the same name (dedup on reconnect)
    for (const [id, ext] of exts) {
        if (ext.name === trimmedName) {
            exts.delete(id);
            console.log(`🔌 Replaced old connection for "${trimmedName}" (${id.substring(0, 8)}...) [key: ${req.apiKey.substring(0, 8)}...]`);
        }
    }

    const extId = uuidv4();
    exts.set(extId, {
        id: extId,
        name: trimmedName,
        types,
        apiKey: req.apiKey,
        connectedAt: Date.now(),
        lastPollAt: null,
    });

    console.log(`🔌 Extension connected: "${trimmedName}" (${extId.substring(0, 8)}...) [key: ${req.apiKey.substring(0, 8)}...] — handles: [${types.join(', ')}]`);

    res.json({
        success: true,
        extensionId: extId,
        name: trimmedName,
        acceptedTypes: types,
    });
});

// GET /api/extensions — List connected extensions (scoped to caller's key)
app.get('/api/extensions', (req, res) => {
    const exts = getExtensionsForKey(req.apiKey);
    const list = [...exts.values()].map(ext => ({
        id: ext.id,
        name: ext.name,
        types: ext.types,
        connectedAt: ext.connectedAt,
        lastPollAt: ext.lastPollAt,
    }));
    res.json({ success: true, extensions: list });
});

// DELETE /api/extensions/:id — Disconnect extension (scoped to caller's key)
app.delete('/api/extensions/:id', (req, res) => {
    const exts = getExtensionsForKey(req.apiKey);
    const ext = exts.get(req.params.id);
    if (!ext) {
        return res.status(404).json({ success: false, error: 'Extension not found' });
    }
    exts.delete(req.params.id);
    console.log(`🔌 Extension disconnected: "${ext.name}" (${ext.id.substring(0, 8)}...) [key: ${req.apiKey.substring(0, 8)}...]`);
    res.json({ success: true });
});

// ============================================
// Per-Key In-Memory Job Queue
// allJobs: Map<apiKey, Map<jobId, job>>
// ============================================

const allJobs = new Map();
const MAX_JOBS_PER_KEY = 100;

function getJobsForKey(apiKey) {
    if (!allJobs.has(apiKey)) allJobs.set(apiKey, new Map());
    return allJobs.get(apiKey);
}

function cleanOldJobs(jobs) {
    if (jobs.size > MAX_JOBS_PER_KEY) {
        const sortedEntries = [...jobs.entries()]
            .sort((a, b) => a[1].createdAt - b[1].createdAt);
        const toRemove = sortedEntries.slice(0, jobs.size - MAX_JOBS_PER_KEY);
        toRemove.forEach(([id]) => jobs.delete(id));
    }
}

// ============================================
// API Routes — Jobs
// ============================================

// Health check — always public, shows aggregate stats
app.get('/health', (_req, res) => {
    const totalJobs = [...allJobs.values()].reduce((s, m) => s + m.size, 0);
    const totalExts = [...connectedExtensions.values()].reduce((s, m) => s + m.size, 0);
    res.json({
        status: 'ok',
        version: 'Alpha 2026.03.11',
        jobCount: totalJobs,
        supportedTypes: Object.keys(SUPPORTED_JOB_TYPES),
        connectedExtensions: totalExts,
    });
});

// GET /api/types — List all supported job types with full schema
app.get('/api/types', (_req, res) => {
    const types = Object.entries(SUPPORTED_JOB_TYPES).map(([key, val]) => ({
        type: key,
        label: val.label,
        description: val.description,
        input: val.input,
        output: val.output,
    }));
    res.json({ success: true, types });
});

// POST /api/jobs — Submit a job (any supported type), scoped to caller's key
// Validates input against schema definition
// Optional: scheduledAt (ISO string or Unix ms) to schedule for later
app.post('/api/jobs', (req, res) => {
    const { type, scheduledAt } = req.body;

    if (!type) {
        return res.status(400).json({ success: false, error: 'type is required' });
    }

    const typeDef = SUPPORTED_JOB_TYPES[type];
    if (!typeDef) {
        return res.status(400).json({
            success: false,
            error: `Unsupported type: "${type}". Available: ${Object.keys(SUPPORTED_JOB_TYPES).join(', ')}`,
        });
    }

    // Validate input against schema
    const { errors, payload } = validateJobInput(typeDef, req.body);
    if (errors.length > 0) {
        return res.status(400).json({ success: false, errors });
    }

    // Parse scheduledAt (ISO string or Unix ms timestamp)
    let scheduledTime = null;
    if (scheduledAt) {
        const parsed = typeof scheduledAt === 'number' ? scheduledAt : new Date(scheduledAt).getTime();
        if (isNaN(parsed)) {
            return res.status(400).json({ success: false, error: 'scheduledAt must be a valid ISO date string or Unix ms timestamp' });
        }
        scheduledTime = parsed;
    }

    const job = {
        id: uuidv4(),
        type,
        payload,                 // generic input — schema-validated
        scheduledAt: scheduledTime,  // null = immediate, timestamp = scheduled
        status: scheduledTime && scheduledTime > Date.now() ? 'scheduled' : 'pending',
        result: null,            // generic output — set by extension
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    const jobs = getJobsForKey(req.apiKey);
    jobs.set(job.id, job);
    cleanOldJobs(jobs);

    // Log a label from the first required field
    const firstField = Object.keys(typeDef.input.required)[0];
    const label = payload[firstField] || '';
    const scheduleLog = scheduledTime ? ` ⏰ scheduled: ${new Date(scheduledTime).toISOString()}` : '';
    console.log(`📥 [${type}] New job: ${job.id.substring(0, 8)}... — "${String(label).substring(0, 50)}"${scheduleLog} [key: ${req.apiKey.substring(0, 8)}...]`);
    res.json({ success: true, jobId: job.id, type, status: job.status, scheduledAt: job.scheduledAt });
});

// GET /api/jobs/pending — Extension polls for next pending job (scoped to caller's key)
// Requires extensionId query param to filter by connected extension's types
app.get('/api/jobs/pending', (req, res) => {
    const { extensionId } = req.query;

    if (!extensionId) {
        return res.status(400).json({ success: false, error: 'extensionId query param is required. Connect first via POST /api/extensions/connect' });
    }

    const exts = getExtensionsForKey(req.apiKey);
    const ext = exts.get(extensionId);
    if (!ext) {
        return res.status(401).json({ success: false, error: 'Extension not connected (or wrong API key). Call POST /api/extensions/connect first' });
    }

    // Update last poll time
    ext.lastPollAt = Date.now();

    const now = Date.now();
    const jobs = getJobsForKey(req.apiKey);

    // Promote scheduled jobs whose time has arrived
    for (const [, job] of jobs) {
        if (job.status === 'scheduled' && job.scheduledAt && job.scheduledAt <= now) {
            job.status = 'pending';
            job.updatedAt = now;
            console.log(`⏰ [${job.type}] Scheduled job ready: ${job.id.substring(0, 8)}... [key: ${req.apiKey.substring(0, 8)}...]`);
        }
    }

    // Find first pending job matching this extension's types (within same key)
    for (const [, job] of jobs) {
        if (job.status === 'pending' && ext.types.includes(job.type)) {
            job.status = 'processing';
            job.updatedAt = now;
            console.log(`🔄 [${job.type}] Job picked up by "${ext.name}": ${job.id.substring(0, 8)}... [key: ${req.apiKey.substring(0, 8)}...]`);
            return res.json({ success: true, job });
        }
    }

    res.json({ success: true, job: null });
});

// PATCH /api/jobs/:id — Extension reports result (scoped to caller's key)
app.patch('/api/jobs/:id', (req, res) => {
    const jobs = getJobsForKey(req.apiKey);
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const { status, result, error } = req.body;

    if (status) job.status = status;
    if (result) job.result = result;     // generic output object
    if (error) job.error = error;
    job.updatedAt = Date.now();

    const emoji = status === 'completed' ? '✅' : '❌';
    console.log(`${emoji} [${job.type}] Job ${status}: ${job.id.substring(0, 8)}... [key: ${req.apiKey.substring(0, 8)}...]`);

    res.json({ success: true, job: { id: job.id, status: job.status } });
});

// GET /api/jobs/:id — Caller checks job status (scoped to caller's key)
app.get('/api/jobs/:id', (req, res) => {
    const jobs = getJobsForKey(req.apiKey);
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
    }
    res.json({ success: true, job });
});

// GET /api/jobs — List all jobs for caller's key (debug)
app.get('/api/jobs', (req, res) => {
    const jobs = getJobsForKey(req.apiKey);
    const jobList = [...jobs.values()]
        .map(j => {
            // Extract label from first payload field
            const typeDef = SUPPORTED_JOB_TYPES[j.type];
            const firstField = typeDef ? Object.keys(typeDef.input.required)[0] : null;
            const label = firstField && j.payload?.[firstField] ? String(j.payload[firstField]).substring(0, 80) : '';
            return {
                id: j.id,
                type: j.type,
                label,
                status: j.status,
                createdAt: j.createdAt,
                hasResult: !!j.result,
            };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ success: true, jobs: jobList });
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, () => {
    const keyCount = API_KEYS.size;
    const authStatus = keyCount > 0
        ? `🔒 Auth: ENABLED (${keyCount} key${keyCount > 1 ? 's' : ''})`
        : '🔓 Auth: disabled (local dev)';

    const typeList = Object.entries(SUPPORTED_JOB_TYPES)
        .map(([key, val]) => `    ${key.padEnd(22)} — ${val.label}`)
        .join('\n');

    console.log(`
╔═══════════════════════════════════════════════╗
║  🌉 ClawBridge Alpha 2026.03.11               ║
║  Server: http://localhost:${PORT}                  ║
║  ${authStatus.padEnd(44)}║
╠═══════════════════════════════════════════════╣
║  Supported Job Types:                         ║
╚═══════════════════════════════════════════════╝
${typeList}

  API Endpoints:
    POST /api/extensions/connect → Register extension (per-key)
    GET  /api/extensions         → List extensions (per-key)
    POST /api/jobs               → Submit job (per-key)
    GET  /api/jobs/pending       → Poll (requires extensionId, per-key)
    PATCH /api/jobs/:id          → Report result (per-key)
    GET  /api/jobs/:id           → Check status (per-key)
    GET  /api/types              → List supported types
    `);
});
