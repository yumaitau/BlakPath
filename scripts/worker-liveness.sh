#!/bin/sh
# Liveness probe for the BullMQ worker.
#
# Exit 0 only when the heartbeat file exists and its mtime is within
# WORKER_HEARTBEAT_MAX_AGE_SECONDS (default 30). The worker rewrites the file
# after a Redis PING and deletes it when Redis is unreachable, so a lost
# connection fails this probe and the orchestrator restarts the pod.
set -eu

path="${WORKER_HEARTBEAT_PATH:-/tmp/blakpath-worker-heartbeat}"
max_age="${WORKER_HEARTBEAT_MAX_AGE_SECONDS:-30}"

if [ ! -f "$path" ]; then
  exit 1
fi

now=$(date +%s)
# GNU stat (Alpine, Debian) then BSD stat (developer laptops).
mtime=$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path")
age=$((now - mtime))
if [ "$age" -gt "$max_age" ]; then
  exit 1
fi
