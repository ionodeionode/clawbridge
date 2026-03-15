---
name: clawbridge
description: Submit jobs to ClawBridge and wait for results via browser extensions. Use when you need to generate AI images (flow_generate), post to X/Twitter (post_x), post to Facebook (post_facebook), reply to Facebook comments (reply_facebook_comment), search Google (search_google), search X/Twitter (search_x), or fetch tweets from a profile (fetch_x_profile). Requires Chrome extension workers to be connected.
---

# ClawBridge Skill

Submit automation jobs to ClawBridge — a browser-extension-powered job queue. Chrome extensions pick up jobs and execute them in real browser sessions.

## Prerequisites

1. **ClawBridge** running at `https://clawbridge.ionode.top/`
2. **Chrome extension** (ClawScrap or similar) loaded and connected with correct API key
3. `CLAWBRIDGE_API_KEY` set in `~/.openclaw/.env`

## Setup

```bash
# Add to ~/.openclaw/.env
CLAWBRIDGE_API_KEY=cb_your_key_here
CLAWBRIDGE_URL=https://clawbridge.ionode.top/  # optional, this is the default
```

## Usage

```bash
SCRIPT="$HOME/.openclaw/workspace/skills/clawbridge/clawbridge.sh"

# Search Google
bash "$SCRIPT" search_google --query "Vietnam GDP 2025"

# Search X/Twitter
bash "$SCRIPT" search_x --query "bitcoin price" --count 15 --sort latest

# Fetch tweets from a profile
bash "$SCRIPT" fetch_x_profile --profileUrl "https://x.com/elonmusk" --count 10

# Post to X/Twitter
bash "$SCRIPT" post_x --text "Hello from ClawBridge!"

# Post to Facebook
bash "$SCRIPT" post_facebook --text "Hello from ClawBridge!" --target "personal"

# Reply to Facebook comment
bash "$SCRIPT" reply_facebook_comment --postUrl "https://fb.com/..." --text "Thanks!"

# Generate AI image via Google Flow
bash "$SCRIPT" flow_generate --prompt "a futuristic city at night, cyberpunk style"
bash "$SCRIPT" flow_generate --prompt "a cat" --count 2 --orientation landscape
```

## Options

| Flag | Description |
|------|-------------|
| `--query` | Search query (search_google, search_x) |
| `--text` | Post content (post_x, post_facebook, reply_facebook_comment) |
| `--prompt` | Image prompt (flow_generate) |
| `--profileUrl` | X profile URL (fetch_x_profile) |
| `--postUrl` | Facebook post URL (reply_facebook_comment) |
| `--count` | Number of results / images |
| `--sort` | Sort order: `latest`, `top` (search_x) |
| `--orientation` | `portrait`, `landscape`, `square` (flow_generate) |
| `--model` | AI model name (flow_generate) |
| `--target` | Post target: `personal`, page name (post_facebook) |
| `--commentId` | Target comment ID (reply_facebook_comment) |
| `--timeout` | Max wait seconds (default: 120) |

## Output

All commands output **JSON** to stdout. Errors go to stderr.

- **search_google** → `{ organic[], peopleAlsoAsk[], totalResultsText }`
- **search_x** → `{ tweets[] }`
- **fetch_x_profile** → `{ handle, displayName, tweets[] }`
- **post_x / post_facebook** → `{ message, postUrl }`
- **reply_facebook_comment** → `{ message }`
- **flow_generate** → `{ imageBase64, imageUrls[] }`

## Notes

- Jobs timeout after 120s by default (extension must be online)
- Check bridge status: `curl https://clawbridge.ionode.top//health`
- List connected extensions: `curl -H "Authorization: Bearer $KEY" https://clawbridge.ionode.top/api/extensions`
