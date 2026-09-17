#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"

osascript <<EOF
tell application "Terminal"
  activate
  do script "cd '$ROOT/backend' && npm run dev"
  do script "cd '$ROOT/frontend' && npm run dev"
  do script "cd '$ROOT'"
end tell
EOF