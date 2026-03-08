# 🌉 ClawBridge

**Super Bridge Server** — A generic job dispatcher that connects your applications to browser automation extensions. Define job types with full I/O schemas, schedule jobs, and let connected extensions handle the rest.

---

## ✨ Features

- 🔌 **Extension ecosystem** — any extension can connect and declare what job types it handles
- 📋 **Schema-driven** — each job type defines input/output schemas; bridge validates everything
- ⏰ **Job scheduling** — submit jobs to run immediately or at a scheduled time
- 🔒 **API key auth** — optional Bearer token authentication for VPS deployments
- 🤖 **AI agent friendly** — `GET /api/types` returns full schemas so agents auto-discover capabilities

## 📋 Requirements

- **Node.js** 18+

## 🚀 Quick Start

```bash
git clone <your-repo-url>
cd clawbridge
npm install
node server.js
```

Server starts on `http://localhost:3002`. Set `PORT` env var to change.

### With authentication

```bash
API_KEY=your-secret-key node server.js
```

---

## 📡 API Reference

### Extension Management

#### Connect Extension

```http
POST /api/extensions/connect
```

```json
{
    "name": "ClawScrap",
    "types": ["flow_generate", "post_x", "post_facebook"]
}
```

- ✅ All types exist → returns `extensionId`
- ❌ Unknown type → `400` error
- Same name reconnects → old connection replaced automatically

#### List / Disconnect

```http
GET    /api/extensions
DELETE /api/extensions/:extensionId
```

---

### Job Operations

#### Submit a Job

```http
POST /api/jobs
Authorization: Bearer <key>
Content-Type: application/json
```

**Immediate:**

```json
{
    "type": "post_x",
    "text": "Hello World! 🦀"
}
```

**Scheduled:**

```json
{
    "type": "post_facebook",
    "text": "Scheduled post 📅",
    "mediaUrls": ["https://example.com/image.jpg"],
    "scheduledAt": "2026-03-06T17:00:00+07:00"
}
```

`scheduledAt` accepts ISO 8601 string or Unix timestamp (ms). Omit for immediate execution.

#### Poll for Pending Jobs (Extension)

```http
GET /api/jobs/pending?extensionId=<id>
```

- Returns next pending job matching extension's registered types
- Scheduled jobs auto-promote to `pending` when their time arrives

#### Report Result / Check Status

```http
PATCH /api/jobs/:id        → Report result (extension)
GET   /api/jobs/:id        → Check status (client)
GET   /api/jobs            → List all jobs (debug)
```

#### List Supported Types

```http
GET /api/types
```

Returns full input/output schema for each job type — useful for AI agents and documentation.

---

### Supported Job Types

| Type | Label | Required | Optional |
|------|-------|----------|----------|
| `flow_generate` | AI Image Generation | `prompt` | `model`, `orientation`, `count` |
| `post_x` | Post to X/Twitter | `text` | `mediaUrls` |
| `post_facebook` | Post to Facebook | `text` | `mediaUrls`, `target` |

### Job Statuses

| Status | Description |
|--------|-------------|
| `scheduled` | Waiting for scheduled time |
| `pending` | Ready to be picked up |
| `processing` | Extension is working on it |
| `completed` | Done with result |
| `failed` | Failed with error |

---

## 🔌 Compatible Extensions

| Extension | Job Types | Description |
|-----------|-----------|-------------|
| [ClawScrap](https://github.com/user/clawscrap) | `flow_generate`, `post_x`, `post_facebook` | Browser automation for AI image gen + social posting |

---

## 🔒 VPS Deployment

> **Important:** Use HTTPS (e.g. nginx + Let's Encrypt) to protect your API key in transit.

```bash
API_KEY=your-secret-key PORT=3002 node server.js
```

## ⚠️ Disclaimer

For educational and personal use only. Users are responsible for compliance with third-party platform Terms of Service.

## 📄 License

MIT
