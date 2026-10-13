#!/usr/bin/env bash
# Regenerate src/vistalink/models.py and _async_client.py from ../../spec/openapi.v2.json.
# Needs a venv with the dev extra: uv pip install -e '.[dev]'
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-.venv/bin/python}"
mkdir -p build
"$PY" scripts/prepare_spec.py ../../spec/openapi.v2.json build/openapi.v2.json
# shellcheck disable=SC2046
"$PY" -m datamodel_code_generator --input build/openapi.v2.json --output src/vistalink/models.py $(cat gen.args) 2>/dev/null
"$PY" scripts/make_async.py
echo "python: models.py ($(grep -c '^class ' src/vistalink/models.py) models) + _async_client.py regenerated"
