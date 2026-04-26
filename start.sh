#!/usr/bin/env bash
# F1 in Schools Tournament Platform — launcher for macOS/Linux
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js is not installed. Install Node 18+ from https://nodejs.org"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run detected. Installing dependencies..."
  npm install
fi

echo ""
echo "Starting F1 Tournament Platform — open http://localhost:3000"
echo "Press Ctrl+C to stop."
echo ""
npm start
