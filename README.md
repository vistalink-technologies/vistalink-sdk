# VistaLink API v2 SDKs and CLI

Client libraries and a command line for the VistaLink hotel API v2. All three
are generated from one OpenAPI document, `spec/openapi.v2.json`.

Official SDKs for the VistaLink hotel API v2 (https://api.vistalink.com/v2):
TypeScript (`@vistalink/api`), Python (`vistalink`) and the `vistalink` CLI.
Generated from the published OpenAPI document at
https://api.vistalink.com/v2/openapi.json. `@vistalink/api`, `@vistalink/cli`
and `vistalink` on PyPI are 0.0.1 name reservations; the unscoped `vistalink`
npm package is not published yet. The first working release is 2.0.0,
published from this repository. Docs: https://vistalink.com/developers/docs.

## Layout

```
spec/
  openapi.v2.json        the API's published OpenAPI document (https://api.vistalink.com/v2/openapi.json)
packages/
  typescript/            @vistalink/api: openapi-typescript types + thin openapi-fetch client (ESM+CJS, Node 20+, browsers)
  python/                vistalink: datamodel-code-generator pydantic models + thin httpx client (sync + async)
  cli/                   @vistalink/cli: `vistalink` command on commander, built on @vistalink/api
  vistalink-unscoped/    vistalink (npm): claims the unscoped name; its `vistalink` bin runs @vistalink/cli
scripts/
  regenerate.sh          regenerate all three from spec/openapi.v2.json (`--test` also builds and tests)
  sync_versions.py       SDK versions follow the spec's info.version, or VERSION_PIN (see Versioning)
  VERSION_PIN            0.0.1 while the names are being reserved
  reserve.sh             prints (never runs) the name-reservation publish commands
  spec_diff.py           structural OpenAPI diff (used for the nightly PR body)
.github/workflows/
  spec-sync.yml          nightly: diff against https://api.vistalink.com/v2/openapi.json, regenerate, test, open a PR (has not run yet)
  publish.yml            on a v* tag: verify, npm publish --provenance (3 packages), PyPI trusted publishing (has not run yet)
```

## Package names

| Artifact | Name | Where it is set |
|---|---|---|
| npm SDK | `@vistalink/api` | `packages/typescript/package.json` |
| npm CLI | `@vistalink/cli` (binary `vistalink`) | `packages/cli/package.json`. The docs already print `npm install -g @vistalink/cli` (`lib/api-content.ts` `CLI_PACKAGE`) |
| npm, unscoped | `vistalink` (binary `vistalink`, runs `@vistalink/cli`) | `packages/vistalink-unscoped/package.json` |
| PyPI | `vistalink` (import `vistalink`) | `packages/python/pyproject.toml` |

On 2026-10-07 all four were unclaimed (`npm view` and PyPI's JSON API both
404). The `@vistalink` npm org has to be created by the company account before
the first scoped publish.

## What every SDK does

- Bearer auth: `Authorization: Bearer vl_live_…` or `vl_test_…`.
- An `Idempotency-Key` is generated for the POSTs that create jobs or
  bookings: `/v2/bookings`, `/v2/rates/batch`, `/v2/rooms/reconcile`, and
  `/v2/rates` when `freshness: "live"`. The caller can override it, and
  retries resend the same key.
- Retries on 429 (honouring `Retry-After`) and 503, with jittered
  exponential backoff.
- Errors come back as `VistaLinkError{code, message, requestId, status,
  details}`. `code` is the API's `error.code`.
- `jobs.wait` / `bookings.wait` polling, `jobs.download` for `rates.batch`
  NDJSON (signed `result_url`, or `GET /v2/jobs/{id}/result` when it is null),
  a booking next-step helper for the three payment modes (`checkout`,
  `handoff`, `external`), `cursor` / `next_cursor` pagination helpers, and
  `webhooks.verify` (HMAC-SHA256 over `"<t>.<body>"` with a
  5-minute tolerance). The tests check `webhooks.verify` against a vector
  produced by the server's own signer.

## Develop

```bash
corepack enable                 # pnpm 10 via packageManager
pnpm install
scripts/regenerate.sh --test    # generate, typecheck, build, test (TS, CLI, Python)
```

Individually: `pnpm --filter @vistalink/api test`, `pnpm --filter @vistalink/cli test`,
`cd packages/python && .venv/bin/pytest`.

To refresh the spec, take the API's published OpenAPI document. A nightly
workflow does the same and opens a pull request when it changes:

```bash
curl -fsSL https://api.vistalink.com/v2/openapi.json -o spec/openapi.v2.json
scripts/regenerate.sh --test
```

## Versioning

- **SDK major.minor = spec `info.version` major.minor.** Spec 2.0.x gives
  SDKs 2.0.x, and a spec at 2.1.0 moves every SDK to 2.1.0.
- The **patch** belongs to the SDKs: client fixes and docs that leave the API
  unchanged. It resets to 0 when the spec's minor moves.
  `scripts/sync_versions.py` enforces this in all six places the version
  lives. `--check` fails CI on drift.
- **Pin (name reservation).** While `scripts/VERSION_PIN` exists, its version
  is used everywhere and the spec rule is suspended, so neither a plain run nor
  the nightly spec-sync bumps 0.0.1 back to 2.0.0.
  `python3 scripts/sync_versions.py --reserve [0.0.x]` writes the pin (default
  0.0.1) and applies it; `--unpin` deletes it and re-applies the spec rule
  (0.0.x becomes the spec's `major.minor.0`). Unpin when the API v2 launch
  release is cut.
- The three packages always ship the same version from the same commit, so
  `@vistalink/api@2.1.3`, `@vistalink/cli@2.1.3` and `vistalink==2.1.3` were
  built from the same spec.
- Breaking API changes come with a new spec major and therefore a new SDK
  major. `X-VistaLink-Client: vistalink-ts/<v>` and
  `vistalink-python/<v>` are sent on every request so the API can see which
  versions are in use.

## Publishing

### Reserving the names (once, by hand)

`scripts/reserve.sh` prints the exact commands, in order, and runs none of
them: preflight (`sync_versions.py --check`, `regenerate.sh --test`),
`npm login`, then `pnpm --filter <pkg> publish --tag reserve --access public
--no-git-checks` for `@vistalink/api`, `@vistalink/cli` and `vistalink`, then
`python -m build`, `twine check --strict` and `twine upload` for PyPI.

- `pnpm publish` is used rather than `npm publish` in the package directory
  because it rewrites `workspace:*` to the real version and runs each
  package's `prepublishOnly` (typecheck, build, tests). `npm login`'s
  credentials are what it publishes with.
- The `reserve` dist-tag keeps 0.0.x off `latest` where the registry allows it.
  On a brand-new package npm may still point `latest` at the only version
  that exists.
- `publishConfig` is `{"access": "public"}` only. Provenance is passed on the
  command line in CI, because `publishConfig.provenance: true` makes a laptop
  publish fail.

### Releases (CI, on a `v*` tag)

`.github/workflows/publish.yml` checks `sync_versions.py --check` and that the
tag equals the package version, runs `regenerate.sh --test` and fails on
uncommitted generated code. Then:

- **npm**, with `permissions: id-token: write`: `pnpm pack` each package, then
  `npm publish <tarball> --provenance --access public --tag <reserve|latest>`,
  SDK first. Once the packages exist, set up **trusted publishing** on
  npmjs.com for each one (package settings → Trusted publisher → GitHub Actions:
  repo plus `publish.yml`), and then no `NPM_TOKEN` is needed. Until then the
  job falls back to the `NPM_TOKEN` secret. The CLI bundles the SDK at build
  time, so its only runtime dependency is `commander`.
- **PyPI**, with **trusted publishing**: on pypi.org add a publisher for
  project `vistalink` (owner/repo, workflow `publish.yml`, environment `pypi`).
  The job builds sdist + wheel, runs `twine check --strict`, and uploads with
  `pypa/gh-action-pypi-publish`.

Neither registry needs a long-lived token after the reservation.

## Status and known gaps

- The SDKs are generated from the API's published spec, `https://api.vistalink.com/v2/openapi.json`.
- When `Job.result_url` is null, the result is downloaded from
  `GET /v2/jobs/{id}/result` with the API key. A signed `result_url` elsewhere
  is fetched without the key.
- API v2 has no key-management endpoints. `vistalink keys create|revoke`
  point to the dashboard.
