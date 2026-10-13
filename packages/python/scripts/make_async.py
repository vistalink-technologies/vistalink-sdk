"""Derive src/vistalink/_async_client.py from the sync _client.py.

The two clients share request building (_base.py); only the I/O layer
differs, so the async file is a mechanical rewrite of the sync one. Run after
editing _client.py (scripts/regenerate.sh does).
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1] / "src" / "vistalink"
s = (ROOT / "_client.py").read_text()

R = [
    ('class VistaLink:\n    """Synchronous VistaLink API v2 client.\n\n    >>> vl = VistaLink(api_key=os.environ["VISTALINK_API_KEY"])\n    >>> vl.search.run({"query": "rooftop near the Pantheon"}).hotels\n    """',
     'class AsyncVistaLink:\n    """Asynchronous VistaLink API v2 client (same surface as :class:`VistaLink`, awaitable).\n\n    >>> async with AsyncVistaLink(api_key=os.environ["VISTALINK_API_KEY"]) as vl:\n    ...     (await vl.search.run({"query": "rooftop near the Pantheon"})).hotels\n    """'),
    ("import time\n", "import asyncio\nimport time\n"),
    ("from typing import Any, Callable, Iterable, Iterator, Mapping",
     "from typing import Any, AsyncIterator, Awaitable, Callable, Iterable, Mapping"),
    ("sleep: Callable[[float], None] = time.sleep", "sleep: Callable[[float], Awaitable[None]] = asyncio.sleep"),
    ("http_client: httpx.Client | None", "http_client: httpx.AsyncClient | None"),
    ("httpx.Client(timeout=timeout)", "httpx.AsyncClient(timeout=timeout)"),
    ("    def close(self) -> None:\n        if self._owns_client:\n            self._http.close()",
     "    async def aclose(self) -> None:\n        if self._owns_client:\n            await self._http.aclose()"),
    ('    def __enter__(self) -> "VistaLink":\n        return self\n\n    def __exit__(self, *exc: object) -> None:\n        self.close()',
     '    async def __aenter__(self) -> "AsyncVistaLink":\n        return self\n\n    async def __aexit__(self, *exc: object) -> None:\n        await self.aclose()'),
    ("    def _send(", "    async def _send("),
    ("response = self._http.request(", "response = await self._http.request("),
    ("self._sleep(", "await self._sleep("),
    ("    def _poll(self, get: Callable[[], Any]", "    async def _poll(self, get: Callable[[], Awaitable[Any]]"),
    ("            value = get()", "            value = await get()"),
    ("client: VistaLink", "client: AsyncVistaLink"),
]
for a, b in R:
    assert a in s, a[:60]
    s = s.replace(a, b)
s = re.sub(r"\n    def (?!__init__)(\w+)\(self", r"\n    async def \1(self", s)
for a, b in [
    ("return self._c._send(", "return await self._c._send("),
    ("return self._c._poll(", "return await self._c._poll("),
    ("job = self._c._poll(", "job = await self._c._poll("),
    ("        self._c._send(b.webhook_delete(", "        await self._c._send(b.webhook_delete("),
    ("job = self.wait(job_id,", "job = await self.wait(job_id,"),
    ("return job, self.download(job)", "return job, await self.download(job)"),
    ("r = self.get(", "r = await self.get("),
    ("return self.run(", "return await self.run("),
    ("-> Iterator[m.SearchResponse]:", "-> AsyncIterator[m.SearchResponse]:"),
    ("        page = self.run(payload)", "        page = await self.run(payload)"),
    ("            page = self.run({**payload", "            page = await self.run({**payload"),
    ("-> Iterator[m.Job]:", "-> AsyncIterator[m.Job]:"),
    ("            page = self.list(**query, cursor=cursor)\n            yield from page.jobs",
     "            page = await self.list(**query, cursor=cursor)\n            for job in page.jobs:\n                yield job"),
]:
    assert a in s, a[:60]
    s = s.replace(a, b)
(ROOT / "_async_client.py").write_text('"""Generated from _client.py by scripts/make_async.py; do not edit by hand."""\n' + s)
