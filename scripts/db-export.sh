#!/usr/bin/env bash
# Export the tracker DB from its Docker named volume to the host.
#
# The live DB can't be bind-mounted (SQLite WAL needs mmap coherence that macOS
# bind mounts don't provide — see docker-compose.yml), so it lives in the
# llm-tracker-data volume. This pulls a consistent, checkpointed snapshot out
# for querying or backup, without stopping the container.
#
# Usage: npm run db:export [dest]     (default: ./.docker-data/agent-monitor.export.db)
set -euo pipefail

CONTAINER="llm-usage-tracker"
DEST="${1:-./.docker-data/agent-monitor.export.db}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "error: container '$CONTAINER' is not running (start it with: docker compose up -d)" >&2
  exit 1
fi

# VACUUM INTO takes a read transaction, so the snapshot is consistent even while
# the tracker is writing — and the output is already checkpointed (no -wal sidecar).
docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  const db = new Database("/data/agent-monitor.db", { readonly: true });
  db.exec("VACUUM INTO \x27/tmp/agent-monitor.export.db\x27");
'

mkdir -p "$(dirname "$DEST")"
docker cp "$CONTAINER:/tmp/agent-monitor.export.db" "$DEST"
docker exec "$CONTAINER" rm -f /tmp/agent-monitor.export.db

echo "exported -> $DEST"
sqlite3 "$DEST" "SELECT 'sessions=' || (SELECT COUNT(*) FROM sessions) ||
                        ' agents='   || (SELECT COUNT(*) FROM agents) ||
                        ' events='   || (SELECT COUNT(*) FROM agent_events);" 2>/dev/null || true
