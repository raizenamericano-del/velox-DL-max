#!/usr/bin/env bash
# ==========================================================================
# Replays the Dockerfile's COPY/RUN order outside of Docker.
#
# Why this exists: package.json has a `postinstall` hook that runs
# scripts/ensure-ytdlp.js. If the Dockerfile ever copies package*.json and
# runs `npm ci` BEFORE scripts/ exists, the build dies with
# "Cannot find module /app/scripts/ensure-ytdlp.js" — a failure that only
# shows up on Railway, minutes into a deploy.
#
# This script reproduces that exact sequence locally (or in CI) in seconds.
# ==========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${PORT:-8098}"
cleanup() { [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

step "[6/11] COPY package*.json + scripts"
cp "$ROOT"/package*.json "$WORK"/
cp -r "$ROOT"/scripts "$WORK"/
[ -f "$WORK/scripts/ensure-ytdlp.js" ] || { echo "FAIL: postinstall target missing"; exit 1; }

step "[7/11] RUN npm ci --omit=dev --ignore-scripts"
cd "$WORK"
npm ci --omit=dev --ignore-scripts
echo "  ok — dependencies installed without needing app source"

step "[8/11] COPY server + public"
cp -r "$ROOT"/server "$WORK"/
cp -r "$ROOT"/public "$WORK"/

step "[9] boot + health check (same probe as the Dockerfile HEALTHCHECK)"
PORT="$PORT" node server/index.js > "$WORK/boot.log" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" > "$WORK/health.json" 2>/dev/null; then
    echo "  ok — /api/health 200 after ${i}s"
    node -e '
      const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (h.status !== "ok") { console.error("FAIL: health status = " + h.status); process.exit(1); }
      if (!h.engine?.available) { console.error("FAIL: engine unavailable"); process.exit(1); }
      console.log(`  engine: yt-dlp ${h.engine.version} [${h.engine.source}] · ffmpeg ${h.engine.ffmpeg} · ${h.platforms} platforms`);
    ' "$WORK/health.json"
    break
  fi
  [ "$i" = 30 ] && { echo "FAIL: server never became healthy"; cat "$WORK/boot.log"; exit 1; }
  sleep 1
done

step "[10] static assets"
for p in / /css/app.css /js/app.js /js/icons.js /icon.svg; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${p}")
  [ "$code" = 200 ] || { echo "FAIL: ${p} → ${code}"; exit 1; }
  echo "  ok — ${p} 200"
done

printf '\n\033[32m✓ Docker build order verified\033[0m\n'
