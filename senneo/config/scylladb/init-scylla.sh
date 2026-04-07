#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# ScyllaDB Auto-Init Script
# Waits for ScyllaDB to be ready, then applies the schema CQL file.
# Used as Docker entrypoint override in docker-compose.yml.
# ═══════════════════════════════════════════════════════════════════════════════
set -e

echo "[scylla-init] Starting ScyllaDB..."

# Start ScyllaDB in background
/docker-entrypoint.py "$@" &
SCYLLA_PID=$!

# Wait for ScyllaDB to accept CQL connections
echo "[scylla-init] Waiting for ScyllaDB to be ready..."
MAX_WAIT=120
ELAPSED=0
until cqlsh -e "DESCRIBE KEYSPACES" > /dev/null 2>&1; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [ $ELAPSED -ge $MAX_WAIT ]; then
    echo "[scylla-init] ERROR: ScyllaDB did not become ready in ${MAX_WAIT}s"
    exit 1
  fi
done
echo "[scylla-init] ScyllaDB is ready (${ELAPSED}s)"

# Apply schema
if [ -f /etc/scylla/init.cql ]; then
  echo "[scylla-init] Applying schema from /etc/scylla/init.cql..."
  cqlsh -f /etc/scylla/init.cql
  echo "[scylla-init] Schema applied successfully"
else
  echo "[scylla-init] WARNING: /etc/scylla/init.cql not found, skipping schema init"
fi

# Wait for ScyllaDB process
wait $SCYLLA_PID
