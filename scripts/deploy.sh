#!/usr/bin/env bash
# One-shot: load Wikipedia data into Neon, snapshot it, deploy to Vercel, run QA.
# Needs DATABASE_URL (Neon) and VERCEL_TOKEN in the environment (or DATABASE_URL in .env.local).
# Optional OPENAI_API_KEY to (re)generate ChatGPT Image artwork first.
# Secrets are passed via env/stdin only and never echoed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${DATABASE_URL:-}" && -f .env.local ]]; then
  DATABASE_URL="$(grep -E '^(DATABASE_URL|POSTGRES_URL)=' .env.local | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  export DATABASE_URL
fi
: "${DATABASE_URL:?DATABASE_URL (Neon) is required}"
: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"

if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  python3 pipeline/artwork.py
fi

python3 db/load.py                      # Wikipedia data -> Neon
npm run --silent db:export              # Neon -> public/graph.json snapshot

npx --yes vercel@latest link --yes --token "$VERCEL_TOKEN" ${VERCEL_SCOPE:+--scope "$VERCEL_SCOPE"} >/dev/null
# (Re)set the production DATABASE_URL without printing it.
npx --yes vercel@latest env rm DATABASE_URL production --yes --token "$VERCEL_TOKEN" >/dev/null 2>&1 || true
printf '%s' "$DATABASE_URL" | npx --yes vercel@latest env add DATABASE_URL production --token "$VERCEL_TOKEN" >/dev/null
URL="$(npx --yes vercel@latest deploy --prod --yes --token "$VERCEL_TOKEN")"
echo "Deployed: $URL"
BASE_URL="$URL" node qa/qa.mjs
