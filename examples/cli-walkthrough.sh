#!/usr/bin/env bash
# CLI walkthrough. Run `npm install && npm run build` first.
# This script does not configure or print API credentials.
set -euo pipefail

CLI="node dist/src/cli.js"
WORKDIR="${1:-$PWD/demo-worker-cwd}"
mkdir -p "$WORKDIR"

$CLI up

# Returns once Pi accepted the prompt; it does NOT mean the task is finished.
$CLI spawn \
  --cwd "$WORKDIR" \
  --prompt "Create hello.txt containing hello from a Pi worker. Then reply DONE." \
  --name demo-worker \
  --json > /tmp/hs-demo-spawn.json

WORKER_ID=$(node -e "process.stdout.write(require('/tmp/hs-demo-spawn.json').id)")
echo "worker: $WORKER_ID"
$CLI status "$WORKER_ID"

# During the run you may queue a steering message:
#   $CLI send "$WORKER_ID" --message "Also add a timestamp." --mode steer

# Bounded long-poll for completion (and return every event since cursor 0).
$CLI wait "$WORKER_ID" --since 0 --timeout-ms 120000 --json > /tmp/hs-demo-wait.json
node -e "const r=require('/tmp/hs-demo-wait.json'); console.log(r.worker.status, r.worker.result?.text)"

# Optional lifecycle operations:
#   $CLI cancel "$WORKER_ID"
#   $CLI resume "$WORKER_ID" --prompt "Continue with a final summary."

$CLI down
