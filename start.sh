#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Check if server is already running
if lsof -ti:3131 >/dev/null 2>&1; then
  echo "✓ Dev Dashboard already running at http://localhost:3131"
  open "http://localhost:3131"
  exit 0
fi

echo "Starting Dev Dashboard..."
node server.js &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 20); do
  if curl -s http://localhost:3131 >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

echo "Opening browser..."
open "http://localhost:3131"

echo ""
echo "Press Ctrl+C to stop the dashboard"
echo ""

# Keep running and cleanup on exit
trap "kill $SERVER_PID 2>/dev/null; echo 'Dashboard stopped.'" EXIT INT TERM
wait $SERVER_PID
