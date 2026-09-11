#!/usr/bin/env bash
# Run a command with the REPO-ROOT .env.local exported.
#
# Next only reads .env files from its own project directory (apps/web), but
# this monorepo keeps secrets at the repo root — so `next dev` on its own sees
# neither THEGRAPH_API_KEY nor GOOGLE_GENERATIVE_AI_API_KEY and /scout 503s.
#
# Same shape as run-probe.sh, which already does this for the probe. Kept as a
# wrapper rather than copying the file into apps/web so there is still exactly
# one place secrets live.
#
#   ./with-root-env.sh npm run dev
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "with-root-env: $ENV_FILE not found" >&2
  exit 1
fi

# `set -a` exports everything the file defines. Comments and blank lines are
# fine; values containing '=' survive because this is a source, not a cut.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

exec "$@"
