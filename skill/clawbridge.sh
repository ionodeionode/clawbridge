#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# ClawBridge Skill — Submit jobs to ClawBridge and poll for results
# Usage: clawbridge.sh <job_type> [--key value ...] [--timeout N]
# Compatible: bash 3.x (macOS default)
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# Load OpenClaw env
if [[ -f "$HOME/.openclaw/.env" ]]; then
  set -a; source "$HOME/.openclaw/.env"; set +a
fi

BRIDGE_URL="${CLAWBRIDGE_URL:-https://clawbridge.ionode.top}"
API_KEY="${CLAWBRIDGE_API_KEY:-}"
POLL_INTERVAL=2
TIMEOUT=120

# ── Help / job type ─────────────────────────────────────────────
JOB_TYPE="${1:-}"
shift || true

if [[ -z "$JOB_TYPE" || "$JOB_TYPE" == "--help" || "$JOB_TYPE" == "-h" ]]; then
  cat <<'EOF'
Usage: clawbridge.sh <job_type> [options]

Job types:
  search_google          --query "..." [--count N]
  search_x               --query "..." [--count N] [--sort latest|top]
  fetch_x_profile        --profileUrl "..." [--count N] [--includeReplies true]
  post_x                 --text "..." [--mediaUrls "url1,url2"]
  post_facebook          --text "..." [--target personal|pagename] [--mediaUrls "url1,url2"]
  reply_facebook_comment --postUrl "..." --text "..." [--commentId "id"]
  flow_generate          --prompt "..." [--count N] [--orientation portrait|landscape|square] [--model name]

Global options:
  --timeout N            Max poll seconds (default: 120)
  --help                 Show this help

Config (~/.openclaw/.env):
  CLAWBRIDGE_API_KEY=your_key
  CLAWBRIDGE_URL=https://clawbridge.ionode.top   # optional
EOF
  exit 0
fi

if [[ -z "$API_KEY" ]]; then
  echo "Error: CLAWBRIDGE_API_KEY is not set." >&2
  echo "Add to ~/.openclaw/.env: CLAWBRIDGE_API_KEY=your_key" >&2
  exit 1
fi

# ── Collect flags into a flat string for python ──────────────────
# Format: "key\tvalue\nkey\tvalue\n..."
PAIRS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --*)
      K="${1#--}"
      V="$2"
      PAIRS="${PAIRS}${K}	${V}
"    # tab-separated, newline per pair
      shift 2
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Build JSON payload via python ────────────────────────────────
PAYLOAD=$(python3 - "$JOB_TYPE" "$PAIRS" <<'PYEOF'
import json, sys

job_type = sys.argv[1]
pairs_raw = sys.argv[2]  # "key\tvalue\n..." string

def coerce(v):
    if v.lower() == 'true': return True
    if v.lower() == 'false': return False
    try: return int(v)
    except ValueError: pass
    try: return float(v)
    except ValueError: pass
    return v

payload = {'type': job_type}
for line in pairs_raw.strip().split('\n'):
    if not line.strip():
        continue
    k, v = line.split('\t', 1)
    if k == 'mediaUrls':
        payload[k] = [u.strip() for u in v.split(',') if u.strip()]
    else:
        payload[k] = coerce(v)

print(json.dumps(payload))
PYEOF
)

# ── Check bridge health ──────────────────────────────────────────
if ! curl -sf "${BRIDGE_URL}/health" > /dev/null 2>&1; then
  echo "Error: ClawBridge not reachable at ${BRIDGE_URL}" >&2
  exit 1
fi

# ── Submit job ───────────────────────────────────────────────────
RESPONSE=$(curl -sf -X POST "${BRIDGE_URL}/api/jobs" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

JOB_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])" 2>/dev/null || true)

if [[ -z "$JOB_ID" ]]; then
  echo "Error: Failed to submit job. Response: $RESPONSE" >&2
  exit 1
fi

echo "[$JOB_TYPE] Job submitted: ${JOB_ID:0:8}..." >&2

# ── Poll for result ──────────────────────────────────────────────
ELAPSED=0
while [[ $ELAPSED -lt $TIMEOUT ]]; do
  RESULT=$(curl -sf "${BRIDGE_URL}/api/jobs/${JOB_ID}" \
    -H "Authorization: Bearer ${API_KEY}")

  STATUS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['job']['status'])" 2>/dev/null || echo "unknown")

  case "$STATUS" in
    completed)
      echo "$RESULT" | python3 -c "
import sys, json
result = json.load(sys.stdin)['job']['result']
print(json.dumps(result, ensure_ascii=False, indent=2))
"
      echo "[$JOB_TYPE] Done ✓" >&2
      exit 0
      ;;
    failed)
      ERR=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['job'].get('error','Unknown error'))" 2>/dev/null)
      echo "Error: Job failed — $ERR" >&2
      exit 1
      ;;
    pending|processing|scheduled)
      sleep "$POLL_INTERVAL"
      ELAPSED=$((ELAPSED + POLL_INTERVAL))
      ;;
    *)
      echo "Error: Unknown status: $STATUS" >&2
      exit 1
      ;;
  esac
done

echo "Error: Timed out after ${TIMEOUT}s (job: $JOB_ID)" >&2
exit 1
