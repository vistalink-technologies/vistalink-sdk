import { Command, CommanderError, Option } from "commander";
import { DEFAULT_BASE_URL, SDK_VERSION, VistaLink, VistaLinkError, bookingNextStep, isJob, type Booking, type Job, type Sleep } from "@vistalink/api";
import { CredentialStore } from "./credentials.js";
import { CliError, EXIT, exitCodeFor } from "./exit-codes.js";
import { bodyFromFlags, hotelRef, hotelsFromFile, kebab, missingRequired, parseValue, queryFromFlags, readArg, type ReadFile } from "./flags.js";
import { OPERATIONS, type Operation } from "./generated/operations.js";
import { json, table } from "./output.js";
import { DELIVERY_HEADERS, RENDERERS, deliveryRow, renderJob } from "./render.js";

export const DASHBOARD_URL = "https://vistalink.com/developers/dashboard";

export interface Deps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  store: CredentialStore;
  /** Read a file; `"-"` means stdin. */
  readFile: ReadFile;
  writeFile: (path: string, data: string) => void;
  /** Prompt for the API key without echo (or read it from piped stdin). */
  readSecret: (prompt: string) => Promise<string>;
  fetch?: (input: Request) => Promise<Response>;
  sleep?: Sleep;
}

interface Globals {
  json?: boolean;
  profile?: string;
  baseUrl?: string;
}

const OP = new Map(OPERATIONS.map((o) => [o.key, o]));
const op = (key: string): Operation => {
  const o = OP.get(key);
  if (!o) throw new Error(`operation ${key} missing from the spec`);
  return o;
};

type Opts = Record<string, unknown> & Globals;
type Handler = (ctx: Ctx, args: string[], opts: Opts) => Promise<void>;

class Ctx {
  constructor(
    readonly deps: Deps,
    readonly globals: Globals,
  ) {}

  get profile() {
    return this.globals.profile ?? this.deps.env.VISTALINK_PROFILE ?? "default";
  }

  baseUrl(stored?: string) {
    return (this.globals.baseUrl ?? this.deps.env.VISTALINK_BASE_URL ?? stored ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  client(requireKey = true, keyOverride?: string): VistaLink {
    const stored = this.deps.store.load(this.profile);
    const apiKey = keyOverride ?? this.deps.env.VISTALINK_API_KEY ?? stored?.key;
    if (requireKey && !apiKey) {
      throw new CliError("No API key. Run `vistalink login` or set VISTALINK_API_KEY.", EXIT.unauthorized, "unauthorized");
    }
    return new VistaLink({ apiKey, baseUrl: this.baseUrl(stored?.meta.base_url), fetch: this.deps.fetch, sleep: this.deps.sleep });
  }

  emit(data: unknown, render?: (d: any) => string) {
    this.deps.stdout(this.globals.json || !render ? json(data) : render(data));
  }

  info(line: string) {
    if (!this.globals.json) this.deps.stderr(line.endsWith("\n") ? line : line + "\n");
  }
}

/** Send one operation through the typed client (auth, retries, errors, idempotency). */
export async function callOperation(
  vl: VistaLink,
  o: Operation,
  pathArgs: string[],
  query: Record<string, string> | undefined,
  body: Record<string, unknown> | undefined,
  idempotencyKey?: string,
): Promise<any> {
  const params = { path: Object.fromEntries(o.pathParams.map((p, i) => [p, pathArgs[i]])), query };
  // An explicit key is always sent. Otherwise one is generated when the spec
  // requires it (bookings) or the call starts a job (x-vistalink-kind job, or
  // live rates under x-vistalink-kind-switch); cached rates go without.
  const startsJob = o.kind === "job" || (o.key === "POST /v2/rates" && body?.freshness === "live");
  const headers = idempotencyKey || (o.idempotent && (o.idempotencyRequired || startsJob)) ? vl._idem({ idempotencyKey }) : undefined;
  const fn = (vl.raw as any)[o.method] as (path: string, init: unknown) => Promise<any>;
  return vl._unwrap(fn(o.path, { params, body: o.body ? body : undefined, headers }));
}

function addOperationOptions(cmd: Command, o: Operation): Command {
  for (const q of o.query) cmd.option(`--${kebab(q.name)} <value>`, q.description || `query parameter ${q.name}`);
  if (o.body) {
    for (const f of o.body) {
      const hint = f.kind === "json" ? "<json>" : f.kind.startsWith("list") ? "<a,b,…|json>" : "<value>";
      cmd.option(`--${kebab(f.name)} ${hint}`, `${f.description || f.name}${f.required ? " (required)" : ""}`);
    }
    cmd.option("--data <json|@file|->", "whole request body as JSON; per-field flags override it");
  }
  if (o.idempotent) cmd.option("--idempotency-key <key>", "Idempotency-Key (generated when omitted)");
  return cmd;
}

function leaf(parent: Command, name: string, description: string): Command {
  return parent.command(name).description(description);
}

function act(cmd: Command, deps: Deps, handler: Handler): Command {
  return cmd.action(async (...a: unknown[]) => {
    const command = a[a.length - 1] as Command;
    const opts = command.optsWithGlobals() as Opts;
    const args = command.processedArgs.flat().filter((x): x is string => typeof x === "string");
    await handler(new Ctx(deps, opts), args, opts);
  });
}

/** Generic `<group> <verb>` from the operations table, exactly as the docs print it. */
function genericHandler(o: Operation, before?: (ctx: Ctx, args: string[], opts: Opts, body: Record<string, unknown>) => void, after?: (ctx: Ctx, data: any, opts: Opts, args: string[]) => Promise<any>): Handler {
  return async (ctx, args, opts) => {
    const body = o.body ? bodyFromFlags(o, opts, ctx.deps.readFile) : undefined;
    if (before && body) before(ctx, args, opts, body);
    if (body) {
      const missing = missingRequired(o, body);
      if (missing.length) throw new CliError(`Missing required ${missing.map((f) => `--${kebab(f.name)}`).join(", ")} (or pass --data)`);
    }
    const vl = ctx.client(!o.public);
    let data = await callOperation(vl, o, args.slice(0, o.pathParams.length), queryFromFlags(o, opts), body, opts.idempotencyKey as string | undefined);
    if (after) data = await after(ctx, data, opts, args);
    if (data !== undefined) ctx.emit(data, RENDERERS[o.key]);
  };
}

function stayFrom(opts: Opts, readFile: ReadFile) {
  const ci = opts.checkIn as string | undefined;
  const co = opts.checkOut as string | undefined;
  if (!ci && !co) return undefined;
  if (!ci || !co) throw new CliError("--check-in and --check-out go together");
  const room: Record<string, unknown> = {};
  if (opts.adults !== undefined) room.adults = parseValue(String(opts.adults), "integer", "adults", readFile);
  if (opts.childrenAges !== undefined) {
    room.children_ages = (parseValue(String(opts.childrenAges), "list", "children-ages", readFile) as unknown[]).map(Number);
  }
  return { check_in: ci, check_out: co, ...(Object.keys(room).length ? { rooms: [room] } : {}) };
}

function addStayOptions(cmd: Command, withAdults = true) {
  cmd.option("--check-in <date>", "YYYY-MM-DD").option("--check-out <date>", "YYYY-MM-DD");
  if (withAdults) cmd.option("--adults <n>", "adults in the room (default 2)").option("--children-ages <a,b>", "children's ages");
  return cmd;
}

async function waitJob(ctx: Ctx, vl: VistaLink, job: Job, opts: Opts): Promise<Job> {
  const timeoutMs = Number(opts.timeout ?? 600) * 1000;
  ctx.info(`job ${job.job_id} (${job.kind}) ${job.status}; waiting…`);
  return vl.jobs.wait(job.job_id, {
    timeoutMs,
    intervalMs: Number(opts.interval ?? 2) * 1000,
    onPoll: (j) => j.progress?.total && ctx.info(`  ${j.status} ${j.progress.done ?? 0}/${j.progress.total}`),
  });
}

/* ── search ──────────────────────────────────────────────────────────── */

function addSearchConvenience(cmd: Command) {
  addStayOptions(cmd);
  return cmd
    .option("--city <name>", "filters.location.city")
    .option("--country <cc>", "filters.location.country (ISO 3166-1 alpha-2)")
    .option("--budget-min <amount>", "filters.budget.min (needs --currency)")
    .option("--budget-max <amount>", "filters.budget.max (needs --currency)")
    .option("--min-stars <n>", "filters.min_stars")
    .option("--amenities <A,B>", "filters.amenities (codes from `vistalink catalog amenities`)");
}

function searchBefore(_ctx: Ctx, args: string[], opts: Opts, body: Record<string, unknown>) {
  if (args[0] !== undefined && body.query === undefined) body.query = args.join(" ");
  const filters = { ...((body.filters as Record<string, unknown>) ?? {}) };
  if (opts.city || opts.country) {
    filters.location = { ...((filters.location as object) ?? {}), ...(opts.city ? { city: opts.city } : {}), ...(opts.country ? { country: opts.country } : {}) };
  }
  const stay = stayFrom(opts, _ctx.deps.readFile);
  if (stay) filters.stay = stay;
  if (opts.budgetMin || opts.budgetMax) {
    const currency = (body.currency as string | undefined) ?? (filters.budget as any)?.currency;
    if (!currency) throw new CliError("--budget-min/--budget-max need --currency (e.g. --currency EUR)");
    filters.budget = { ...(opts.budgetMin ? { min: String(opts.budgetMin) } : {}), ...(opts.budgetMax ? { max: String(opts.budgetMax) } : {}), currency };
  }
  if (opts.minStars !== undefined) filters.min_stars = parseValue(String(opts.minStars), "integer", "min-stars", _ctx.deps.readFile);
  if (opts.amenities !== undefined) filters.amenities = String(opts.amenities).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (Object.keys(filters).length) body.filters = filters;
  if (body.query === undefined && body.search_id === undefined && !Object.keys(filters).length) {
    throw new CliError('Give a query (vistalink search "…") or filters (--city, --check-in, …)');
  }
}

/* ── rates ───────────────────────────────────────────────────────────── */

function addRatesConvenience(cmd: Command) {
  addStayOptions(cmd);
  return cmd
    .option("--live", "fetch live (starts a job, same as --freshness live)")
    .option("--no-wait", "with --live: print the job instead of waiting")
    .option("--timeout <seconds>", "how long to wait for a live job", "600");
}

function ratesBefore(ctx: Ctx, args: string[], opts: Opts, body: Record<string, unknown>) {
  if (args.length && body.hotels === undefined) body.hotels = args.map((a) => hotelRef(a));
  const stay = stayFrom(opts, ctx.deps.readFile);
  if (stay) body.stay = stay;
  if (opts.live) body.freshness = "live";
}

async function ratesAfter(ctx: Ctx, data: any, opts: Opts) {
  if (!isJob(data) || opts.wait === false) return data;
  const done = await waitJob(ctx, ctx.client(), data, opts);
  return done.result ?? done;
}

/* ── program ─────────────────────────────────────────────────────────── */

export function buildProgram(deps: Deps): Command {
  const program = new Command("vistalink")
    .description("Command line for the VistaLink hotel API v2.\nGrammar: vistalink <group> <verb> [id] [--flag value]. Flags are the JSON field names in kebab-case; objects take JSON; --data @file.json sends a whole body.")
    .version(SDK_VERSION, "-v, --version")
    .option("--json", "print the raw JSON response")
    .option("--profile <name>", "credential profile (default: $VISTALINK_PROFILE or 'default')")
    .option("--base-url <url>", `API base URL (default: $VISTALINK_BASE_URL or ${DEFAULT_BASE_URL})`)
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({ writeOut: deps.stdout, writeErr: deps.stderr });

  const groups = new Map<string, Command>();
  const group = (name: string, description: string) => {
    let g = groups.get(name);
    if (!g) {
      g = program.command(name).description(description);
      groups.set(name, g);
    }
    return g;
  };
  const DESCRIPTIONS: Record<string, string> = {
    hotels: "resolve identifiers and read hotel detail",
    search: "search hotels (vistalink search \"…\" is short for search run --query)",
    rates: "cached and live rates (vistalink rates <ids…> is short for rates get)",
    rooms: "room reconciliation across sources",
    bookings: "create, read and cancel bookings",
    jobs: "async jobs: get, list, wait, result, cancel",
    webhooks: "webhook endpoints and deliveries",
    chat: "conversational search",
    catalog: "amenity codes, booking engines, health, the OpenAPI document",
  };

  // Generic commands, one per operation, with per-operation extensions.
  for (const o of OPERATIONS) {
    const [g, verb] = o.cli.split(" ");
    const cmd = leaf(group(g, DESCRIPTIONS[g] ?? g), verb, o.summary || o.key);
    for (const p of o.pathParams) cmd.argument(`<${p}>`);
    addOperationOptions(cmd, o);
    if (o.key === "GET /v2/jobs/{job_id}/result") {
      // NDJSON, not JSON: written as-is.
      cmd.option("--out <path>", "write the NDJSON here (default: stdout)");
      act(cmd, deps, async (ctx, [jobId], opts) => {
        const ndjson = await ctx.client().jobs.result(jobId);
        writeNdjson(ctx, ndjson, opts.out as string | undefined);
      });
      continue;
    }
    if (o.key === "GET /v2/openapi.json") {
      addOpenapiOptions(cmd);
      act(cmd, deps, openapiHandler(o));
      continue;
    }
    let before: Parameters<typeof genericHandler>[1];
    let after: Parameters<typeof genericHandler>[2];
    switch (o.key) {
      case "POST /v2/hotels/resolve":
        cmd.argument("[inputs...]", "Booking/Expedia/website URLs, hotel names (with --city) or JSON identifiers");
        cmd.option("--city <name>", "city for name inputs").option("--country <cc>", "country for name inputs");
        before = (_c, args, opts, body) => {
          if (args.length && body.identifiers === undefined) {
            body.identifiers = args.map((a) => {
              const r = hotelRef(a, { city: opts.city as string, country: opts.country as string });
              if (typeof r === "string") throw new CliError(`${a} is already a hotel id`);
              return r;
            });
          }
        };
        break;
      case "POST /v2/search":
        cmd.argument("[query...]", "free-text query (same as --query)");
        addSearchConvenience(cmd);
        before = searchBefore;
        break;
      case "POST /v2/rates":
        cmd.argument("[hotels...]", "hotel ids or URLs (same as --hotels)");
        addRatesConvenience(cmd);
        before = ratesBefore;
        after = ratesAfter;
        break;
      case "POST /v2/rates/batch":
        addStayOptions(cmd);
        cmd
          .option("--file <path>", "hotels, one per line: id, URL or JSON identifier ('-' = stdin)")
          .option("--out <path>", "write the NDJSON result here (default: stdout)")
          .option("--no-wait", "print the job instead of waiting and downloading")
          .option("--timeout <seconds>", "how long to wait", "3600");
        before = (ctx, _a, opts, body) => {
          if (opts.file) body.hotels = hotelsFromFile(ctx.deps.readFile(String(opts.file)));
          const stay = stayFrom(opts, ctx.deps.readFile);
          if (stay) body.stays = [...((body.stays as unknown[]) ?? []), stay];
        };
        after = async (ctx, job: Job, opts) => {
          if (opts.wait === false) return job;
          const vl = ctx.client();
          const done = await waitJob(ctx, vl, job, opts);
          await writeJobResult(ctx, vl, done, opts.out as string | undefined);
          return undefined;
        };
        break;
      case "POST /v2/rooms/reconcile":
        cmd
          .option("--hotel <id>", "hotel id (same as --hotel-id)")
          .option("--source <kind=url>", "booking_url=…, website_url=… or expedia_url=… (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
          .option("--supplied <file>", "your own rooms: JSON array, or {label, rooms}")
          .option("--label <name>", "label for --supplied rooms", "supplied")
          .option("--no-wait", "print the job instead of waiting")
          .option("--timeout <seconds>", "how long to wait", "600");
        before = (ctx, _a, opts, body) => {
          if (opts.hotel) body.hotel_id = opts.hotel;
          const sources = [...((body.sources as unknown[]) ?? [])];
          for (const s of (opts.source as string[] | undefined) ?? []) {
            const i = s.indexOf("=");
            const kind = s.slice(0, i);
            if (i < 0 || !["booking_url", "website_url", "expedia_url"].includes(kind)) {
              throw new CliError(`--source expects booking_url=…, website_url=… or expedia_url=… (got ${s})`);
            }
            sources.push({ kind, url: s.slice(i + 1) });
          }
          if (opts.supplied) {
            const v = JSON.parse(readArg(`@${opts.supplied}`, ctx.deps.readFile));
            const rooms = Array.isArray(v) ? v : v.rooms;
            if (!Array.isArray(rooms)) throw new CliError("--supplied must hold a JSON array of rooms or {label, rooms}");
            sources.push({ kind: "rooms", label: (Array.isArray(v) ? undefined : v.label) ?? opts.label, rooms });
          }
          if (sources.length) body.sources = sources;
        };
        after = async (ctx, data, opts) => {
          if (!isJob(data) || opts.wait === false) return data;
          const done = await waitJob(ctx, ctx.client(), data, opts);
          return done.result ?? done;
        };
        break;
      case "POST /v2/bookings":
        cmd
          .addOption(new Option("--payment-mode <mode>", "payment.mode: checkout (hosted checkout link), handoff (hosted guest session) or external (the engine's own prefilled page)").choices(PAYMENT_MODES))
          .option("--return-url <url>", "payment.return_url (checkout: where the guest lands afterwards)")
          .option("--wait", "poll until the booking needs the guest (checkout/handoff/external link) or is final");
        before = (_c, _a, opts, body) => {
          if (opts.paymentMode || opts.returnUrl) {
            body.payment = {
              ...((body.payment as Record<string, unknown>) ?? {}),
              ...(opts.paymentMode ? { mode: opts.paymentMode } : {}),
              ...(opts.returnUrl ? { return_url: opts.returnUrl } : {}),
            };
          }
        };
        after = async (ctx, booking: Booking, opts) => {
          if (!opts.wait) return booking;
          ctx.info(`booking ${booking.booking_id} ${booking.status}; waiting…`);
          const done = await ctx.client().bookings.wait(booking.booking_id);
          const next = bookingNextStep(done);
          if (next.url) ctx.info(`next: ${next.action} → ${next.url}`);
          return done;
        };
        break;
      case "DELETE /v2/webhooks/{webhook_id}":
        after = async (_c, _d, _o, args) => ({ webhook_id: args[0], deleted: true }); // 204, no body
        break;
    }
    act(cmd, deps, genericHandler(o, before, after));
  }

  // Shortcuts the task grammar adds on top of the docs grammar.
  const searchOp = op("POST /v2/search");
  const searchGroup = groups.get("search")!;
  searchGroup.argument("[query...]");
  addOperationOptions(searchGroup, searchOp);
  addSearchConvenience(searchGroup);
  act(searchGroup, deps, genericHandler(searchOp, searchBefore));

  const ratesOp = op("POST /v2/rates");
  const ratesGroup = groups.get("rates")!;
  ratesGroup.argument("[hotels...]");
  addOperationOptions(ratesGroup, ratesOp);
  addRatesConvenience(ratesGroup);
  act(ratesGroup, deps, genericHandler(ratesOp, ratesBefore, ratesAfter));

  const resolveOp = op("POST /v2/hotels/resolve");
  act(
    program
      .command("resolve")
      .description("resolve URLs or names to hotel ids (short for hotels resolve)")
      .argument("<inputs...>")
      .option("--city <name>")
      .option("--country <cc>"),
    deps,
    async (ctx, args, opts) => {
      const identifiers = args.map((a) => {
        const r = hotelRef(a, { city: opts.city as string, country: opts.country as string });
        if (typeof r === "string") throw new CliError(`${a} is already a hotel id`);
        return r;
      });
      const data = await callOperation(ctx.client(), resolveOp, [], undefined, { identifiers });
      ctx.emit(data, RENDERERS[resolveOp.key]);
    },
  );

  const hotelOp = op("GET /v2/hotels/{hotel_id}");
  const hotelCmd = program.command("hotel").description("hotel detail (short for hotels get)").argument("<hotel_id>");
  addOperationOptions(hotelCmd, hotelOp);
  act(hotelCmd, deps, genericHandler(hotelOp));

  // jobs wait
  act(
    group("jobs", DESCRIPTIONS.jobs)
      .command("wait")
      .description("poll a job until succeeded, failed or canceled")
      .argument("<job_id>")
      .option("--timeout <seconds>", "give up after", "600")
      .option("--interval <seconds>", "first poll interval", "2")
      .option("--out <path>", "rates.batch: write the NDJSON result here (default: stdout)")
      .option("--no-download", "rates.batch: print the job instead of downloading its result"),
    deps,
    async (ctx, [jobId], opts) => {
      const vl = ctx.client();
      const job = await vl.jobs.wait(jobId, {
        timeoutMs: Number(opts.timeout) * 1000,
        intervalMs: Number(opts.interval) * 1000,
        throwOnFailure: false,
        onPoll: (j) => ctx.info(`  ${j.status}${j.progress?.total ? ` ${j.progress.done ?? 0}/${j.progress.total}` : ""}`),
      });
      if (job.status === "succeeded" && hasDownloadableResult(job) && opts.download !== false) {
        await writeJobResult(ctx, vl, job, opts.out as string | undefined);
        return;
      }
      ctx.emit(job, renderJob);
      if (job.status === "failed") throw new CliError(job.error?.message ?? "job failed", EXIT.job_failed, "job_failed");
      if (job.status === "canceled") throw new CliError("job canceled", EXIT.job_canceled, "job_canceled");
    },
  );

  // webhooks tail
  act(
    group("webhooks", DESCRIPTIONS.webhooks)
      .command("tail")
      .description("follow a webhook's deliveries (polls the deliveries endpoint)")
      .argument("<webhook_id>")
      .option("--interval <seconds>", "poll interval", "5")
      .option("--once", "print the current deliveries and exit")
      .addOption(new Option("--max-polls <n>").hideHelp()),
    deps,
    async (ctx, [webhookId], opts) => {
      const vl = ctx.client();
      const seen = new Set<string>();
      let headerPrinted = false;
      const maxPolls = opts.maxPolls ? Number(opts.maxPolls) : opts.once ? 1 : Infinity;
      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(Number(opts.interval) * 1000);
        const page = await vl.webhooks.deliveries(webhookId, { limit: 50 });
        const fresh = page.deliveries.filter((d) => !seen.has(`${d.delivery_id}:${d.status}:${d.attempts}`));
        fresh.sort((a, b) => a.created_at.localeCompare(b.created_at));
        for (const d of fresh) {
          seen.add(`${d.delivery_id}:${d.status}:${d.attempts}`);
          if (ctx.globals.json) {
            deps.stdout(JSON.stringify(d) + "\n");
          } else {
            const t = table(DELIVERY_HEADERS, [deliveryRow(d)]).split("\n");
            deps.stdout((headerPrinted ? "" : t[0] + "\n") + t[1] + "\n");
            headerPrinted = true;
          }
        }
      }
    },
  );

  // openapi (the docs print `catalog openapi`; `openapi` is the short form)
  const openapiOp = op("GET /v2/openapi.json");
  act(addOpenapiOptions(program.command("openapi").description("the OpenAPI document (short for catalog openapi)")), deps, openapiHandler(openapiOp));

  // login / logout / keys
  act(
    program
      .command("login")
      .description("store an API key for this machine (OS keychain when available, else ~/.config/vistalink/credentials, 0600)")
      .option("--no-verify", "store without checking the key against the API"),
    deps,
    async (ctx, _a, opts) => {
      const key = (await deps.readSecret("VistaLink API key (vl_live_… or vl_test_…): ")).trim();
      if (!/^vl_(live|test)_\S+$/.test(key)) throw new CliError("That does not look like a VistaLink key (vl_live_… or vl_test_…)");
      if (opts.verify !== false) await ctx.client(true, key).jobs.list({ limit: 1 });
      const meta = deps.store.save(ctx.profile, key, ctx.globals.baseUrl);
      if (ctx.globals.json) deps.stdout(json({ profile: ctx.profile, ...meta }));
      else deps.stdout(`Logged in (profile ${ctx.profile}, ${meta.key_hint}, stored in ${meta.store}).\n`);
      if (deps.env.VISTALINK_API_KEY) ctx.info("Note: VISTALINK_API_KEY is set and takes precedence over stored keys.");
    },
  );

  act(program.command("logout").description("remove the stored key for the profile"), deps, async (ctx) => {
    const removed = deps.store.remove(ctx.profile);
    deps.stdout(ctx.globals.json ? json({ profile: ctx.profile, removed }) : removed ? `Removed profile ${ctx.profile}.\n` : `No stored key for profile ${ctx.profile}.\n`);
  });

  const keys = program.command("keys").description("API keys: stored profiles here; create/revoke in the dashboard");
  act(keys.command("list").description("list keys stored on this machine"), deps, async (ctx) => {
    const profiles = deps.store.profiles();
    const rows = Object.entries(profiles).map(([name, m]) => ({ profile: name, active: name === ctx.profile, ...m }));
    if (ctx.globals.json) return deps.stdout(json({ profiles: rows, env_key: !!deps.env.VISTALINK_API_KEY }));
    deps.stdout(table(["", "profile", "key", "store", "base_url", "saved_at"], rows.map((r) => [r.active ? "*" : "", r.profile, r.key_hint, r.store, r.base_url, r.saved_at])));
    if (deps.env.VISTALINK_API_KEY) deps.stdout("VISTALINK_API_KEY is set and overrides these.\n");
  });
  for (const verb of ["create", "revoke"]) {
    act(keys.command(verb).description(`${verb} a key (dashboard only; API v2 has no key endpoints)`).argument("[key_id]"), deps, async () => {
      throw new CliError(`API v2 has no key-management endpoint. ${verb === "create" ? "Create" : "Revoke"} keys at ${DASHBOARD_URL} (then \`vistalink login\`).`, EXIT.not_implemented, "not_implemented");
    });
  }

  return program;
}

const PAYMENT_MODES = ["checkout", "handoff", "external"];

/** A job whose result is a download (NDJSON) rather than inline `result`. */
function hasDownloadableResult(job: Job): boolean {
  return job.kind === "rates.batch" || !!job.result_url;
}

function addOpenapiOptions(cmd: Command): Command {
  return cmd.option("--url", "print the document's URL instead of fetching it");
}

function openapiHandler(o: Operation): Handler {
  return async (ctx, _a, opts) => {
    if (opts.url) {
      const stored = ctx.deps.store.load(ctx.profile);
      const url = `${ctx.baseUrl(stored?.meta.base_url)}${o.path}`;
      ctx.deps.stdout(ctx.globals.json ? json({ url }) : url + "\n");
      return;
    }
    ctx.deps.stdout(json(await callOperation(ctx.client(false), o, [], undefined, undefined)));
  };
}

/**
 * Download a finished job's NDJSON: `result_url` when it is a signed link
 * elsewhere (no API key sent), else `GET /v2/jobs/{id}/result`.
 */
async function writeJobResult(ctx: Ctx, vl: VistaLink, job: Job, out?: string): Promise<void> {
  writeNdjson(ctx, await vl.jobs.download(job), out);
}

function writeNdjson(ctx: Ctx, ndjson: string, out?: string) {
  if (out) {
    ctx.deps.writeFile(out, ndjson);
    ctx.info(`wrote ${ndjson.split("\n").filter(Boolean).length} lines to ${out}`);
  } else {
    ctx.deps.stdout(ndjson);
  }
}

/** Run the CLI and return the process exit code (never calls process.exit). */
export async function run(argv: string[], deps: Deps): Promise<number> {
  const program = buildProgram(deps);
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.code === "commander.help") return EXIT.ok;
      return EXIT.usage; // commander already printed the message
    }
    const wantsJson = argv.includes("--json");
    if (err instanceof VistaLinkError) {
      if (wantsJson) {
        deps.stderr(json({ error: { code: err.code, message: err.message, status: err.status, request_id: err.requestId, details: err.details } }));
      } else {
        const meta = [`code=${err.code}`, err.status ? `status=${err.status}` : "", err.requestId ? `request_id=${err.requestId}` : ""].filter(Boolean).join(" ");
        deps.stderr(`Error: ${err.message} (${meta})\n`);
        const fields = (err.details as { fields?: Array<{ loc?: unknown[]; msg?: string; field?: string; message?: string }> } | null)?.fields;
        for (const f of fields ?? []) deps.stderr(`  ${f.field ?? f.loc?.join(".") ?? ""}: ${f.message ?? f.msg ?? ""}\n`);
      }
    } else if (err instanceof CliError) {
      deps.stderr(wantsJson ? json({ error: { code: err.code, message: err.message } }) : `Error: ${err.message}\n`);
    } else {
      deps.stderr(`Error: ${(err as Error)?.stack ?? String(err)}\n`);
    }
    return exitCodeFor(err);
  }
}

