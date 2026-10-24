#!/usr/bin/env bash
set -e

if [ -z "$1" ]; then
  echo "Usage: ./push_to_github.sh <GITHUB_REPO_URL>"
  echo "Example: ./push_to_github.sh https://github.com/your-username/ergopulse-coach.git"
  exit 1
fi

REPO_URL="$1"

if [ ! -d ".git" ]; then
  git init
  git branch -M main
fi

git add -A
git commit -m "feat: initial commit of ErgoPulse Coach (B×C Hybrid AI Agent for JPHACKS 2026)" || true

if git remote | grep -q "^origin$"; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

echo "Pushing ErgoPulse Coach to $REPO_URL ..."
git push -u origin main
echo "✅ Push completed!"
