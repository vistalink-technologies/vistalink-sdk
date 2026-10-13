#!/usr/bin/env bash
# Print, in order, the commands that reserve the package names on npm and PyPI
# with the 0.0.x placeholder release. This script NEVER runs them: it only
# prints. A person with the company npm and PyPI accounts copies them into a
# terminal at the repository root.
#
#   scripts/reserve.sh
#
# After the names exist, every later release goes out from CI on a v* tag
# (.github/workflows/publish.yml) with npm provenance and PyPI trusted
# publishing; npm trusted publishing can only be configured on a package that
# already exists, which is why this first publish is manual.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f scripts/VERSION_PIN ]; then
  echo "scripts/VERSION_PIN is missing: run 'python3 scripts/sync_versions.py --reserve' first." >&2
  exit 1
fi
V="$(tr -d '[:space:]' < scripts/VERSION_PIN)"

cat <<CMDS
# Reserve @vistalink/api, @vistalink/cli, vistalink (npm) and vistalink (PyPI) at ${V}.
# Run from: ${ROOT}
# Nothing below has been run. Paste it one block at a time.

# 0. Preflight: versions pinned, everything builds and passes.
python3 scripts/sync_versions.py --check          # expect: versions pinned at ${V}
corepack enable && pnpm install --frozen-lockfile
scripts/regenerate.sh --test

# 1. npm: sign in as the account that owns the @vistalink org
#    (create the org at https://www.npmjs.com/org/create if it does not exist yet).
npm login
npm whoami

# 2. npm: publish in this order, SDK first (the CLI bundles it, the unscoped
#    package depends on the CLI). pnpm publish rewrites workspace:* to ${V} and
#    runs each package's prepublishOnly (build + tests). Add --otp=<code> if
#    the account has 2FA for writes.
pnpm --filter @vistalink/api publish --tag reserve --access public --no-git-checks
pnpm --filter @vistalink/cli publish --tag reserve --access public --no-git-checks
pnpm --filter vistalink      publish --tag reserve --access public --no-git-checks

npm view @vistalink/api dist-tags && npm view @vistalink/cli dist-tags && npm view vistalink dist-tags

# 3. PyPI: build, check, upload. twine asks for the username (__token__) and an
#    API token from https://pypi.org/manage/account/token/ (account-scoped:
#    the project does not exist yet, so a project-scoped token is impossible).
cd packages/python
uv pip install -p .venv/bin/python -e '.[dev,release]'
rm -rf dist && .venv/bin/python -m build
.venv/bin/twine check --strict dist/*
.venv/bin/twine upload dist/vistalink-${V}.tar.gz dist/vistalink-${V}-py3-none-any.whl
cd ../..

# 4. Afterwards: on pypi.org add the trusted publisher for project vistalink
#    (repo vistalink-technologies/vistalink-sdk, workflow publish.yml,
#    environment pypi), on npmjs.com add the trusted publisher for each of the
#    three packages (same repo and workflow), then delete the PyPI token.
CMDS
