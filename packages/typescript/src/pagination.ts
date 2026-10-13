/** A page from any cursor-paginated endpoint (`cursor` in, `next_cursor` out). */
export interface CursorPage {
  next_cursor?: string | null;
}

/**
 * Iterate pages: `fetchPage(cursor)` is called with `undefined` first, then
 * with each `next_cursor` until it is null/absent.
 */
export async function* paginate<P extends CursorPage>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  opts: { maxPages?: number } = {},
): AsyncGenerator<P, void, undefined> {
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(cursor);
    yield page;
    pages++;
    if (!page.next_cursor || (opts.maxPages !== undefined && pages >= opts.maxPages)) return;
    cursor = page.next_cursor;
  }
}

/** Flatten `paginate` into items, e.g. `items(fetchPage, (p) => p.jobs)`. */
export async function* paginateItems<P extends CursorPage, I>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  pick: (page: P) => I[] | null | undefined,
  opts: { maxPages?: number } = {},
): AsyncGenerator<I, void, undefined> {
  for await (const page of paginate(fetchPage, opts)) {
    for (const item of pick(page) ?? []) yield item;
  }
}
