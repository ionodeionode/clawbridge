const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3002;
const API_KEY = process.env.API_KEY || null;
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
// API Key Authentication
// ============================================

function authMiddleware(req, res, next) {
    // Skip auth if no API_KEY is configured (local dev)
    if (!API_KEY) return next();

    // Health endpoint is always public
    if (req.path === '/health') return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Missing API key. Use Authorization: Bearer <key>' });
    }

    const token = authHeader.replace('Bearer ', '');
    if (token !== API_KEY) {
        return res.status(403).json({ success: false, error: 'Invalid API key' });
    }

    next();
}

app.use(authMiddleware);

// ============================================
// Extension Registry (in-memory)
// ============================================

const connectedExtensions = new Map();

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

    // Remove old connections with the same name (dedup on reconnect)
    const trimmedName = name.trim();
    for (const [id, ext] of connectedExtensions) {
        if (ext.name === trimmedName) {
            connectedExtensions.delete(id);
            console.log(`🔌 Replaced old connection for "${trimmedName}" (${id.substring(0, 8)}...)`);
        }
    }

    const extId = uuidv4();
    connectedExtensions.set(extId, {
        id: extId,
        name: name.trim(),
        types,
        connectedAt: Date.now(),
        lastPollAt: null,
    });

    console.log(`🔌 Extension connected: "${name.trim()}" (${extId.substring(0, 8)}...) — handles: [${types.join(', ')}]`);

    res.json({
        success: true,
        extensionId: extId,
        name: name.trim(),
        acceptedTypes: types,
    });
});

// GET /api/extensions — List connected extensions
app.get('/api/extensions', (_req, res) => {
    const list = [...connectedExtensions.values()].map(ext => ({
        id: ext.id,
        name: ext.name,
        types: ext.types,
        connectedAt: ext.connectedAt,
        lastPollAt: ext.lastPollAt,
    }));
    res.json({ success: true, extensions: list });
});

// DELETE /api/extensions/:id — Disconnect extension
app.delete('/api/extensions/:id', (req, res) => {
    const ext = connectedExtensions.get(req.params.id);
    if (!ext) {
        return res.status(404).json({ success: false, error: 'Extension not found' });
    }
    connectedExtensions.delete(req.params.id);
    console.log(`🔌 Extension disconnected: "${ext.name}" (${ext.id.substring(0, 8)}...)`);
    res.json({ success: true });
});

// ============================================
// In-Memory Job Queue
// ============================================

const jobs = new Map();
const MAX_JOBS = 100;

function cleanOldJobs() {
    if (jobs.size > MAX_JOBS) {
        const sortedEntries = [...jobs.entries()]
            .sort((a, b) => a[1].createdAt - b[1].createdAt);
        const toRemove = sortedEntries.slice(0, jobs.size - MAX_JOBS);
        toRemove.forEach(([id]) => jobs.delete(id));
    }
}

// ============================================
// API Routes — Jobs
// ============================================

// Health check
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        version: 'Alpha 2026.03.08',
        jobCount: jobs.size,
        supportedTypes: Object.keys(SUPPORTED_JOB_TYPES),
        connectedExtensions: connectedExtensions.size,
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

// POST /api/jobs — Submit a job (any supported type)
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

    jobs.set(job.id, job);
    cleanOldJobs();

    // Log a label from the first required field
    const firstField = Object.keys(typeDef.input.required)[0];
    const label = payload[firstField] || '';
    const scheduleLog = scheduledTime ? ` ⏰ scheduled: ${new Date(scheduledTime).toISOString()}` : '';
    console.log(`📥 [${type}] New job: ${job.id.substring(0, 8)}... — "${String(label).substring(0, 50)}"${scheduleLog}`);
    res.json({ success: true, jobId: job.id, type, status: job.status, scheduledAt: job.scheduledAt });
});

// GET /api/jobs/pending — Extension polls for next pending job
// Requires extensionId query param to filter by connected extension's types
app.get('/api/jobs/pending', (req, res) => {
    const { extensionId } = req.query;

    if (!extensionId) {
        return res.status(400).json({ success: false, error: 'extensionId query param is required. Connect first via POST /api/extensions/connect' });
    }

    const ext = connectedExtensions.get(extensionId);
    if (!ext) {
        return res.status(401).json({ success: false, error: 'Extension not connected. Call POST /api/extensions/connect first' });
    }

    // Update last poll time
    ext.lastPollAt = Date.now();

    const now = Date.now();

    // Promote scheduled jobs whose time has arrived
    for (const [, job] of jobs) {
        if (job.status === 'scheduled' && job.scheduledAt && job.scheduledAt <= now) {
            job.status = 'pending';
            job.updatedAt = now;
            console.log(`⏰ [${job.type}] Scheduled job ready: ${job.id.substring(0, 8)}...`);
        }
    }

    // Find first pending job matching this extension's types
    for (const [, job] of jobs) {
        if (job.status === 'pending' && ext.types.includes(job.type)) {
            job.status = 'processing';
            job.updatedAt = now;
            console.log(`🔄 [${job.type}] Job picked up by "${ext.name}": ${job.id.substring(0, 8)}...`);
            return res.json({ success: true, job });
        }
    }

    res.json({ success: true, job: null });
});

// PATCH /api/jobs/:id — Extension reports result
app.patch('/api/jobs/:id', (req, res) => {
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
    console.log(`${emoji} [${job.type}] Job ${status}: ${job.id.substring(0, 8)}...`);

    res.json({ success: true, job: { id: job.id, status: job.status } });
});

// GET /api/jobs/:id — Caller checks job status
app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
    }
    res.json({ success: true, job });
});

// GET /api/jobs — List all jobs (debug)
app.get('/api/jobs', (_req, res) => {
    const allJobs = [...jobs.values()]
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
    res.json({ success: true, jobs: allJobs });
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, () => {
    const authStatus = API_KEY ? '🔒 Auth: ENABLED' : '🔓 Auth: disabled (no API_KEY set)';
    const typeList = Object.entries(SUPPORTED_JOB_TYPES)
        .map(([key, val]) => `    ${key.padEnd(18)} — ${val.label}`)
        .join('\n');

    console.log(`
╔═══════════════════════════════════════════════╗
║  🌉 ClawBridge Alpha 2026.03.08               ║
║  Server: http://localhost:${PORT}                  ║
║  ${authStatus.padEnd(44)}║
╠═══════════════════════════════════════════════╣
║  Supported Job Types:                         ║
╚═══════════════════════════════════════════════╝
${typeList}

  API Endpoints:
    POST /api/extensions/connect → Register extension
    GET  /api/extensions         → List extensions
    POST /api/jobs               → Submit job
    GET  /api/jobs/pending       → Poll (requires extensionId)
    PATCH /api/jobs/:id          → Report result
    GET  /api/jobs/:id           → Check status
    GET  /api/types              → List supported types
    `);
});
