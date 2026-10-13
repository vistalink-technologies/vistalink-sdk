#!/usr/bin/env bash
# Regenerate the TypeScript types, the CLI operation table and the Python
# models from spec/openapi.v2.json, then (with --test) build and test all three.
#
#   scripts/regenerate.sh            # generate only
#   scripts/regenerate.sh --test     # generate, build, typecheck, test
#
# Needs: node 20+ with corepack/pnpm, python 3.10+ and uv (or a ready
# packages/python/.venv with the dev extra).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 -c 'import json,sys; d=json.load(open("spec/openapi.v2.json")); assert d["openapi"].startswith("3.1"), d["openapi"]; print("spec", d["info"]["version"], len(d["paths"]), "paths")'

python3 scripts/sync_versions.py

pnpm install --frozen-lockfile >/dev/null
pnpm --filter @vistalink/api run generate
pnpm --filter @vistalink/cli run generate

PYDIR=packages/python
if [ ! -x "$PYDIR/.venv/bin/python" ]; then
  uv venv -q -p 3.12 "$PYDIR/.venv"
  uv pip install -q -p "$PYDIR/.venv/bin/python" -e "$PYDIR[dev]"
fi
"$PYDIR/scripts/generate.sh"

if [ "${1:-}" = "--test" ]; then
  pnpm --filter @vistalink/api run typecheck
  pnpm --filter @vistalink/api run test
  pnpm --filter @vistalink/api run build
  pnpm --filter @vistalink/cli run typecheck
  pnpm --filter @vistalink/cli run test
  pnpm --filter @vistalink/cli run build
  pnpm --filter vistalink run test
  (cd "$PYDIR" && .venv/bin/pytest -q)
fi
echo "regenerated from spec/openapi.v2.json"
