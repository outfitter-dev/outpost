#!/usr/bin/env bash
# Boot a relaycast self-host image and wait for /health to report ok.
#   scripts/smoke-relaycast.sh <image>
set -euo pipefail

image="${1:?usage: smoke-relaycast.sh <image>}"
name="relaycast-smoke-$$"
port="${SMOKE_PORT:-18787}"

cleanup() {
  docker logs "$name" >/tmp/relaycast-smoke.log 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$name-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Same hardening as upstream's docker-compose.yml: read-only root, /data volume, tmpfs /tmp.
docker run -d --name "$name" \
  --read-only --tmpfs /tmp:size=64m,mode=1777 -v "$name-data:/data" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -p "127.0.0.1:${port}:8787" \
  "$image" --base-url https://relay.example.com >/dev/null

for _ in $(seq 1 30); do
  if body="$(curl -fsS "http://127.0.0.1:${port}/health" 2>/dev/null)" && grep -q '"ok":true' <<<"$body"; then
    echo "healthy: $body"
    exit 0
  fi
  sleep 2
done

echo "relaycast did not become healthy in 60s" >&2
docker logs "$name" >&2 || true
exit 1
