import { bookingNextStep, type Booking, type Job, type components } from "@vistalink/api";
import { type Cell, json, kv, money, table } from "./output.js";

type S = components["schemas"];
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function renderResolve(r: S["ResolveResponse"]): string {
  return table(
    ["#", "status", "hotel_id", "match", "basis / reason"],
    r.results.map((x) => [x.input, x.status, x.hotel_id, x.match, x.basis ?? x.reason ?? x.booking_slug]),
  );
}

export function renderSearch(r: S["SearchResponse"]): string {
  let out = "";
  if (r.status === "needs_clarification") {
    for (const c of r.clarifications ?? []) {
      out += `? ${c.question}  (clarification_id ${c.id})\n`;
      for (const o of c.options ?? []) out += `    ${o.id}  ${o.label}\n`;
    }
    out += `Answer with: vistalink search run --search-id ${r.search_id} --answers '[{"clarification_id":"…","option_id":"…"}]'\n`;
    return out;
  }
  out += table(
    ["rank", "hotel_id", "name", "stars", "score", "city", "rate"],
    (r.hotels ?? []).map((h) => [
      h.rank,
      h.hotel_id,
      h.name,
      h.star_rating,
      h.review_score,
      h.location?.city,
      h.rate ? `${money(h.rate.total, h.rate.currency) ?? "-"} (${h.rate.status})` : undefined,
    ]),
  );
  const meta: string[] = [];
  if (r.search_id) meta.push(`search_id ${r.search_id}`);
  if (r.total_estimate != null) meta.push(`~${r.total_estimate} matches`);
  if (r.next_cursor) meta.push(`next page: --search-id ${r.search_id} --cursor ${r.next_cursor}`);
  if (r.billing) meta.push(`billed ${r.billing.amount} ${r.billing.currency ?? "USD"} (${r.billing.sku})`);
  for (const w of r.warnings ?? []) meta.push(`warning: ${(w as Any).code} ${(w as Any).message ?? ""}`.trim());
  return out + (meta.length ? "\n" + meta.join("\n") + "\n" : "");
}

function offersRows(hotelId: string | undefined, rooms: Any[] | undefined): Cell[][] {
  const rows: Cell[][] = [];
  for (const room of rooms ?? []) {
    for (const o of room.offers ?? []) {
      rows.push([hotelId, room.name ?? o.room_name, o.rate_name, money(o.total, o.currency), o.board, o.free_cancellation, o.channel, o.offer_id]);
    }
  }
  return rows;
}

export function renderRates(r: S["RatesResponse"]): string {
  const status = table(
    ["#", "hotel_id", "status", "channel", "engine", "observed_at"],
    r.results.map((x) => [x.input, x.hotel_id, x.status, x.channel, x.engine, x.observed_at]),
  );
  const rows = r.results.flatMap((x) => offersRows(x.hotel_id ?? undefined, x.rooms as Any[]));
  const offers = rows.length ? "\n" + table(["hotel_id", "room", "rate", "total", "board", "free cxl", "channel", "offer_id"], rows) : "";
  const s = r.summary;
  const summary = s ? `\nobserved ${s.observed} · stale ${s.stale} · unknown ${s.unknown} · unsupported ${s.unsupported} · unresolved ${s.unresolved}\n` : "";
  return status + offers + summary;
}

export function renderHotel(h: S["HotelDetailResponse"]): string {
  const c = h.core;
  const l = h.location;
  let out = kv([
    ["hotel_id", h.hotel_id],
    ["name", c?.name],
    ["type", c?.hotel_type],
    ["stars", c?.star_rating],
    ["reviews", c?.review_score != null ? `${c.review_score} (${c.review_count ?? 0})` : undefined],
    ["address", l ? [l.address, l.city, l.country].filter(Boolean).join(", ") : undefined],
    ["check-in/out", c?.check_in_time ? `${c.check_in_time} / ${c.check_out_time ?? "-"}` : undefined],
    ["website", c?.website_url],
    ["images", h.images ? String(h.images.count ?? h.images.items?.length ?? 0) : undefined],
    ["sections", h.sections_present?.join(",")],
  ]);
  if (h.rooms?.length) {
    out += "\n" + table(["room_id", "room", "m²", "occupancy", "offers"], h.rooms.map((r) => [r.room_id, r.name, r.size_m2, r.max_occupancy ?? r.occupancy, r.offers?.length ?? 0]));
  }
  const ch = h.rates?.channels ?? [];
  if (ch.length) {
    const rows = ch.flatMap((x) => (x.offers ?? []).map((o) => [x.channel, o.room_name, o.rate_name, money(o.total, o.currency), o.board, o.free_cancellation, o.offer_id] as Cell[]));
    out += "\n" + table(["channel", "room", "rate", "total", "board", "free cxl", "offer_id"], rows);
  }
  if (h.rates?.refresh_job) out += `\nrefresh job: ${h.rates.refresh_job.job_id} (vistalink jobs wait ${h.rates.refresh_job.job_id})\n`;
  return out;
}

export function renderJob(j: Job): string {
  return kv([
    ["job_id", j.job_id],
    ["kind", j.kind],
    ["status", j.status],
    ["progress", j.progress ? `${j.progress.done ?? 0}/${j.progress.total ?? "?"}` : undefined],
    ["created_at", j.created_at],
    ["updated_at", j.updated_at],
    ["estimated", j.estimated_seconds != null ? `${j.estimated_seconds}s` : undefined],
    ["result_url", j.result_url ?? undefined],
    ["error", j.error ? `${j.error.code}: ${j.error.message}` : undefined],
    ["billing", j.billing ? `${j.billing.amount} ${j.billing.currency ?? "USD"} (${j.billing.sku})` : undefined],
  ]);
}

export function renderJobs(r: S["JobList"]): string {
  const t = table(
    ["job_id", "kind", "status", "progress", "created_at"],
    r.jobs.map((j) => [j.job_id, j.kind, j.status, j.progress ? `${j.progress.done ?? 0}/${j.progress.total ?? "?"}` : undefined, j.created_at]),
  );
  return t + (r.next_cursor ? `\nmore: --cursor ${r.next_cursor}\n` : "");
}

function nextStep(b: Booking): string | undefined {
  const n = bookingNextStep(b);
  if (n.url) return `${n.action}: send the guest to ${n.url}${n.expiresAt ? ` (expires ${n.expiresAt})` : ""}`;
  return n.action === "wait" ? `wait (vistalink bookings get ${b.booking_id})` : undefined;
}

export function renderBooking(b: Booking): string {
  return kv([
    ["booking_id", b.booking_id],
    ["status", b.status],
    ["hotel_id", b.hotel_id],
    ["offer", b.offer ? `${b.offer.room_name ?? ""} ${b.offer.rate_name ?? ""}`.trim() || b.offer.offer_id : undefined],
    ["total", b.offer ? money(b.offer.total, b.offer.currency) : undefined],
    ["payment", b.payment ? `${b.payment.mode} · ${b.payment.status}` : undefined],
    ["checkout_url", b.payment?.checkout_url ?? undefined],
    ["handoff_url", b.handoff?.url ?? undefined],
    ["next", nextStep(b)],
    ["confirmation", b.confirmation?.code ?? undefined],
    ["failure", b.failure ? `${b.failure.reason}${b.failure.message ? ": " + b.failure.message : ""}` : undefined],
  ]);
}

export function renderReconcile(r: S["ReconcileResult"]): string {
  let out = kv([
    ["hotel_id", r.hotel_id],
    ["reconciliation_id", r.reconciliation_id],
    ["version", r.version],
  ]);
  out +=
    "\n" +
    table(
      ["room", "confidence", "sources", "conflicts"],
      (r.rooms ?? []).map((x) => [
        (x.canonical as Any)?.name,
        x.confidence,
        (x.listings as Any[] | undefined)?.map((l) => l.source).join(",") ?? "",
        (x.conflicts ?? []).map((c) => c.field).join(","),
      ]),
    );
  const un = Object.entries((r.unmatched ?? {}) as Record<string, unknown[]>).filter(([, v]) => v?.length);
  if (un.length) out += "\nunmatched: " + un.map(([k, v]) => `${k} ${v.length}`).join(", ") + "\n";
  return out;
}

export function renderWebhooks(r: S["WebhookList"]): string {
  return table(["webhook_id", "url", "events", "active", "created_at"], r.webhooks.map((w) => [w.webhook_id, w.url, w.events.join(","), w.is_active, w.created_at]));
}

export function renderWebhookCreated(w: S["WebhookCreated"]): string {
  return kv([
    ["webhook_id", w.webhook_id],
    ["url", w.url],
    ["events", w.events.join(",")],
    ["secret", w.secret],
  ]) + "\nThe secret is shown once. Store it; verify deliveries with it.\n";
}

export function deliveryRow(d: S["WebhookDelivery"]): Cell[] {
  return [d.created_at, d.delivery_id, d.event, d.status, d.attempts, d.last_status_code, d.last_error];
}
export const DELIVERY_HEADERS = ["created_at", "delivery_id", "event", "status", "attempts", "http", "error"];

export function renderDeliveries(r: S["WebhookDeliveryList"]): string {
  return table(DELIVERY_HEADERS, r.deliveries.map(deliveryRow)) + (r.next_cursor ? `\nmore: --cursor ${r.next_cursor}\n` : "");
}

export function renderAmenities(r: S["AmenityList"]): string {
  return table(["code", "label", "category", "kind"], r.amenities.map((a) => [a.code, a.label, a.category, a.kind]));
}

export function renderEngines(r: S["EngineList"]): string {
  return table(["engine", "name", "live_rates", "book", "success", "hotels"], r.engines.map((e) => [e.engine, e.name, e.live_rates, e.book, e.success_class, e.hotel_count]));
}

export function renderChat(r: S["ChatResponse"]): string {
  let out = (r.message ?? "") + "\n";
  if (r.hotels?.length) out += "\n" + table(["hotel_id", "name", "stars", "rate"], r.hotels.map((h) => [h.hotel_id, h.name, h.star_rating, h.rate ? money(h.rate.total, h.rate.currency) : undefined]));
  if (r.session_id) out += `\nsession_id ${r.session_id}\n`;
  return out;
}

/** Renderer per operation key; anything missing falls back to JSON. */
export const RENDERERS: Record<string, (data: any) => string> = {
  "POST /v2/hotels/resolve": renderResolve,
  "GET /v2/hotels/{hotel_id}": renderHotel,
  "POST /v2/search": renderSearch,
  "POST /v2/rates": (d) => ("job_id" in d ? renderJob(d) : renderRates(d)),
  "POST /v2/rates/batch": renderJob,
  "POST /v2/rooms/reconcile": (d) => ("job_id" in d ? renderJob(d) : renderReconcile(d)),
  "POST /v2/bookings": renderBooking,
  "GET /v2/bookings/{booking_id}": renderBooking,
  "POST /v2/bookings/{booking_id}/cancel": renderBooking,
  "GET /v2/jobs": renderJobs,
  "GET /v2/jobs/{job_id}": renderJob,
  "POST /v2/jobs/{job_id}/cancel": renderJob,
  "GET /v2/webhooks": renderWebhooks,
  "POST /v2/webhooks": renderWebhookCreated,
  "DELETE /v2/webhooks/{webhook_id}": (d) => (d?.deleted === false ? json(d) : "deleted\n"),
  "GET /v2/webhooks/{webhook_id}/deliveries": renderDeliveries,
  "POST /v2/chat": renderChat,
  "GET /v2/amenities": renderAmenities,
  "GET /v2/engines": renderEngines,
  "GET /v2/health": (d) => kv(Object.entries(d).map(([k, v]) => [k, typeof v === "object" && v !== null ? JSON.stringify(v) : (v as Cell)])),
};
