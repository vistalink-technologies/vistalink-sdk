# @vistalink/cli

> 0.0.x reserves the name; the first working release is 2.0.0, tracking API v2.

`vistalink` is the command line for the VistaLink hotel API v2. It is built on
`@vistalink/api` (bundled into the binary) and `commander`, and runs on
Node 20+.


```bash
npm install -g @vistalink/cli
vistalink login                     # prompts; or: echo "$KEY" | vistalink login
vistalink search "quiet place near the Colosseum with a rooftop" --check-in 2026-11-14 --check-out 2026-11-16
```

## Grammar

The grammar is the one the docs print:

```
vistalink <group> <verb> [id] [--flag value]…
```

Flags are the JSON field names in kebab-case. Scalars are bare, arrays of
scalars are comma-joined, and objects or arrays of objects are JSON
(`@file.json` works too). `--data @body.json` (or `-` for stdin) sends a whole
body, and per-field flags override it. Query parameters are flags as well.
`--json` prints the raw response; without it you get tables. Every command
in the docs works as printed. `test/docs-grammar.test.ts` replays all 22
samples the docs print, plus the same 22 built from `spec/openapi.v2.json`
without the site's parameter overlay.

The `<group> <verb>` of every API operation comes from the spec's
`x-vistalink-cli` (`scripts/gen-operations.mjs` fails if an operation lacks
it). Whether a command takes `--idempotency-key` comes from the declared
`Idempotency-Key` header. A key is generated when that header is required
(bookings) or the call starts a job (`x-vistalink-kind: job`, or `--live`
rates).

| Group | Verbs (docs) | Extras |
|---|---|---|
| `hotels` | `resolve`, `get <hotel_id>` | `resolve <url\|name…> [--city --country]` |
| `search` | `run` | `search "<query>" [--city --country --check-in --check-out --adults --budget-min --budget-max --min-stars --amenities]` |
| `rates` | `get`, `batch` | `rates <ids\|urls…> --check-in --check-out [--live] [--channel direct\|third_party]`; `rates batch --file hotels.txt --check-in --check-out [--out r.ndjson]` waits and downloads the NDJSON (signed `result_url`, else `GET /v2/jobs/{id}/result`) |
| `rooms` | `reconcile` | `--hotel <id> --source booking_url=… --source website_url=… [--supplied rooms.json]`, waits for the job |
| `bookings` | `create`, `get <id>`, `cancel <id>` | `create --payment-mode checkout\|handoff\|external [--return-url]`; `create --wait` polls until the guest has to act (prints the checkout, handoff or external link as `next`) or the booking is final (`confirmed`, `failed`, `expired`, `canceled`) |
| `jobs` | `list`, `get <id>`, `result <id>`, `cancel <id>` | `wait <id> [--timeout --interval]`. For a `rates.batch` job it downloads the NDJSON (`--out`, `--no-download`). `result <id> [--out]` writes the NDJSON as-is |
| `webhooks` | `list`, `create`, `delete <id>`, `deliveries <id>` | `tail <id> [--interval 5] [--once]` |
| `chat` | `send` | |
| `catalog` | `amenities`, `engines`, `health`, `openapi` | `openapi` fetches the document (public). `--url` prints only its URL |

Shortcuts: `vistalink resolve …` = `hotels resolve`, `vistalink hotel <id>` =
`hotels get`, `vistalink openapi` = `catalog openapi`.

Account commands: `login [--no-verify]`, `logout`, `keys list` (keys stored
on this machine, masked). `keys create` and `keys revoke` exit 11 and point
to the dashboard, because API v2 has no key-management endpoint.

Global flags: `--json`, `--profile <name>` (`$VISTALINK_PROFILE`), `--base-url <url>` (`$VISTALINK_BASE_URL`).

## Credentials

The key comes from `VISTALINK_API_KEY` if that is set. Otherwise it is the
key stored for the profile by `vistalink login`. Storage needs no native
modules:

- macOS: login keychain via `/usr/bin/security`. The key goes in on stdin
  (`security -i`), never in argv.
- Linux with a Secret Service: `secret-tool`, key on stdin.
- Everywhere else, or with `VISTALINK_CREDENTIAL_STORE=file`:
  `~/.config/vistalink/credentials` (directory 0700, file 0600).

`~/.config/vistalink/config.json` holds non-secret metadata (store, masked
key, base URL).

## Exit codes

| code | meaning |
|---|---|
| 0 | ok |
| 1 | unexpected error |
| 2 | usage error / `bad_request` |
| 3 | `unauthorized` (also: no key) |
| 4 | `forbidden` |
| 5 | `not_found` |
| 6 | `conflict` |
| 7 | `rate_limited` (after retries) |
| 8 | `insufficient_credit` |
| 9 | `upstream_error` |
| 10 | `unavailable` (after retries) |
| 11 | `not_implemented` |
| 12 | `network_error` |
| 13 | `timeout` (waiting) |
| 14 | `job_failed` |
| 15 | `job_canceled` |

Errors go to stderr as `Error: <message> (code=… status=… request_id=…)`. With
`--json` they are a JSON object instead.

## Development

```bash
pnpm run generate   # src/generated/operations.ts from ../../spec/openapi.v2.json (names from x-vistalink-cli)
pnpm test           # argument parsing, output formatting, exit codes, docs samples
pnpm build          # dist/cli.js (bin) + dist/index.js
node scripts/docs-samples.mjs <vistalink.com>/content/openapi.v2.json "<label>" test/fixtures/docs-cli-samples.json
node scripts/docs-samples.mjs ../../spec/openapi.v2.json "<label>" test/fixtures/spec-cli-samples.json
```
