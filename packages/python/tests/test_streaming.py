import httpx
import pytest

from conftest import job
from vistalink import AsyncVistaLink, VistaLink, VistaLinkError, models


class ChunkedSync(httpx.SyncByteStream):
    def __init__(self, *, fail_after_first=False):
        self.closed = False
        self.finished = False
        self.fail_after_first = fail_after_first

    def __iter__(self):
        yield b'{"hotel_id":"h1"}\n'
        if self.fail_after_first:
            raise httpx.ReadError("connection lost")
        self.finished = True
        yield b'{"hotel_id":"h2"}\n'

    def close(self):
        self.closed = True


class ChunkedAsync(httpx.AsyncByteStream):
    def __init__(self):
        self.closed = False
        self.finished = False

    async def __aiter__(self):
        yield b'{"hotel_id":"h1"}\n'
        self.finished = True
        yield b'{"hotel_id":"h2"}\n'

    async def aclose(self):
        self.closed = True


class BrokenSync(httpx.SyncByteStream):
    def __init__(self):
        self.read_started = False
        self.closed = False

    def __iter__(self):
        self.read_started = True
        raise httpx.ReadError("body stream failed")
        yield b""

    def close(self):
        self.closed = True


class BrokenAsync(httpx.AsyncByteStream):
    def __init__(self):
        self.read_started = False
        self.closed = False

    async def __aiter__(self):
        self.read_started = True
        raise httpx.ReadError("body stream failed")
        yield b""

    async def aclose(self):
        self.closed = True


def test_sync_result_stream_is_incremental_and_closes_transport():
    body = ChunkedSync()
    sent = []

    def handler(request):
        sent.append(request)
        return httpx.Response(200, stream=body)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = VistaLink("vl_test_abc", base_url="https://api.test", http_client=http)
    try:
        stream = client.jobs.result_stream("job_1")
        assert next(stream) == b'{"hotel_id":"h1"}\n'
        assert body.finished is False
        assert sent[0].headers["authorization"] == "Bearer vl_test_abc"
        stream.close()
        assert body.closed is True
    finally:
        http.close()


def test_sync_result_stream_maps_midstream_errors_without_restarting():
    body = ChunkedSync(fail_after_first=True)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, stream=body)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = VistaLink("vl_test_abc", base_url="https://api.test", http_client=http, max_retries=3)
    try:
        stream = client.jobs.result_stream("job_1")
        assert next(stream) == b'{"hotel_id":"h1"}\n'
        with pytest.raises(VistaLinkError) as exc:
            next(stream)
        assert exc.value.code == "network_error"
        assert len(calls) == 1
        assert body.closed is True
    finally:
        http.close()


def test_sync_result_stream_retries_a_503_before_emitting_bytes():
    retry_body = ChunkedSync()
    body = ChunkedSync()
    calls = []
    sleeps = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(503, headers={"Retry-After": "0"}, stream=retry_body)
        return httpx.Response(200, stream=body)

    def sleep(delay):
        assert retry_body.closed is True
        sleeps.append(delay)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = VistaLink("vl_test_abc", base_url="https://api.test", http_client=http, max_retries=1, sleep=sleep)
    try:
        stream = client.jobs.result_stream("job_1")
        assert next(stream) == b'{"hotel_id":"h1"}\n'
        assert len(calls) == 2
        assert sleeps == [0.0]
        stream.close()
    finally:
        http.close()


def test_sync_result_stream_closes_body_before_retrying_first_read_failure():
    failed_body = BrokenSync()
    good_body = ChunkedSync()
    calls = []
    sleeps = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200, stream=failed_body)
        return httpx.Response(200, stream=good_body)

    def sleep(delay):
        assert failed_body.closed is True
        sleeps.append(delay)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = VistaLink("vl_test_abc", base_url="https://api.test", http_client=http, max_retries=1, sleep=sleep)
    try:
        stream = client.jobs.result_stream("job_1")
        assert next(stream) == b'{"hotel_id":"h1"}\n'
        assert failed_body.read_started is True
        assert len(calls) == 2
        assert len(sleeps) == 1
        stream.close()
    finally:
        http.close()


def test_sync_signed_non_success_does_not_read_broken_error_body():
    body = BrokenSync()
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(403, stream=body)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = VistaLink("vl_test_abc", base_url="https://api.test", http_client=http, max_retries=3)
    job_model = models.Job.model_validate(job("succeeded", result_url="https://files.test/r.ndjson"))
    try:
        stream = client.jobs.download_stream(job_model)
        with pytest.raises(VistaLinkError) as exc:
            next(stream)
        assert (exc.value.code, exc.value.status) == ("upstream_error", 403)
        assert body.read_started is False
        assert body.closed is True
        assert len(calls) == 1
    finally:
        http.close()


def test_sync_signed_stream_applies_client_timeout_to_initial_and_redirect_requests():
    seen = []
    body = ChunkedSync()
    timeout = httpx.Timeout(7.0, connect=1.5)

    def handler(request):
        seen.append(request)
        if request.url.host == "files.test":
            return httpx.Response(302, headers={"Location": "https://cdn.test/r.ndjson"})
        return httpx.Response(200, stream=body)

    http = httpx.Client(transport=httpx.MockTransport(handler), timeout=timeout)
    client = VistaLink("vl_test_abc", base_url="https://api.test", http_client=http)
    job_model = models.Job.model_validate(job("succeeded", result_url="https://files.test/r.ndjson?sig=abc"))
    expected_timeout = {"connect": 1.5, "read": 7.0, "write": 7.0, "pool": 7.0}
    try:
        stream = client.jobs.download_stream(job_model)
        assert next(stream) == b'{"hotel_id":"h1"}\n'
        assert len(seen) == 2
        assert [request.extensions["timeout"] for request in seen] == [expected_timeout, expected_timeout]
        stream.close()
    finally:
        http.close()


def test_sync_result_stream_resolves_relative_api_urls_and_treats_http_as_cross_origin():
    sent = []
    bodies = [ChunkedSync(), ChunkedSync()]

    def handler(request):
        sent.append(request)
        return httpx.Response(200, stream=bodies[len(sent) - 1])

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = VistaLink("vl_test_abc", base_url="https://api.test", http_client=http)
    relative = models.Job.model_validate(job("succeeded", result_url="/v2/jobs/job_1/result"))
    http_url = models.Job.model_validate(job("succeeded", result_url="http://api.test/v2/jobs/job_1/result"))
    try:
        stream = client.jobs.download_stream(relative)
        assert next(stream) == b'{"hotel_id":"h1"}\n'
        assert str(sent[0].url) == "https://api.test/v2/jobs/job_1/result"
        assert sent[0].headers["authorization"] == "Bearer vl_test_abc"
        stream.close()

        stream = client.jobs.download_stream(http_url)
        assert next(stream) == b'{"hotel_id":"h1"}\n'
        assert str(sent[1].url) == "http://api.test/v2/jobs/job_1/result"
        assert "authorization" not in sent[1].headers
        stream.close()
    finally:
        http.close()


def test_sync_signed_stream_drops_client_credentials_and_headers():
    seen = []
    body = ChunkedSync()

    def handler(request):
        seen.append(request)
        if request.url.host == "files.test":
            return httpx.Response(302, headers={"Location": "https://cdn.test/r.ndjson"})
        return httpx.Response(200, stream=body)

    http = httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer should-not-leak", "X-Private": "private"},
        cookies={"session": "secret"},
        auth=("user", "password"),
    )
    client = VistaLink("vl_test_abc", base_url="https://api.test", http_client=http)
    job_model = models.Job.model_validate(job("succeeded", result_url="https://user:password@files.test/r.ndjson?sig=abc"))
    try:
        stream = client.jobs.download_stream(job_model)
        assert next(stream) == b'{"hotel_id":"h1"}\n'
        assert [str(r.url) for r in seen] == [
            "https://files.test/r.ndjson?sig=abc",
            "https://cdn.test/r.ndjson",
        ]
        for request in seen:
            assert "authorization" not in request.headers
            assert "x-private" not in request.headers
            assert "cookie" not in request.headers
        stream.close()
    finally:
        http.close()


async def test_async_result_stream_is_incremental_and_closes_transport():
    body = ChunkedAsync()
    sent = []

    def handler(request):
        sent.append(request)
        return httpx.Response(200, stream=body)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncVistaLink("vl_test_abc", base_url="https://api.test", http_client=http)
    try:
        stream = client.jobs.result_stream("job_1")
        assert await anext(stream) == b'{"hotel_id":"h1"}\n'
        assert body.finished is False
        assert sent[0].headers["authorization"] == "Bearer vl_test_abc"
        await stream.aclose()
        assert body.closed is True
    finally:
        await http.aclose()


async def test_async_signed_stream_drops_client_credentials_and_headers():
    seen = []
    body = ChunkedAsync()

    def handler(request):
        seen.append(request)
        if request.url.host == "files.test":
            return httpx.Response(302, headers={"Location": "https://cdn.test/r.ndjson"})
        return httpx.Response(200, stream=body)

    timeout = httpx.Timeout(7.0, connect=1.5)
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer should-not-leak", "X-Private": "private"},
        cookies={"session": "secret"},
        auth=("user", "password"),
        timeout=timeout,
    )
    client = AsyncVistaLink("vl_test_abc", base_url="https://api.test", http_client=http)
    job_model = models.Job.model_validate(job("succeeded", result_url="https://user:password@files.test/r.ndjson?sig=abc"))
    try:
        stream = client.jobs.download_stream(job_model)
        assert await anext(stream) == b'{"hotel_id":"h1"}\n'
        assert [str(r.url) for r in seen] == [
            "https://files.test/r.ndjson?sig=abc",
            "https://cdn.test/r.ndjson",
        ]
        for request in seen:
            assert "authorization" not in request.headers
            assert "x-private" not in request.headers
            assert "cookie" not in request.headers
            assert request.extensions["timeout"] == {"connect": 1.5, "read": 7.0, "write": 7.0, "pool": 7.0}
        await stream.aclose()
    finally:
        await http.aclose()


async def test_async_result_stream_closes_503_before_backoff():
    retry_body = ChunkedAsync()
    body = ChunkedAsync()
    calls = []
    sleeps = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(503, headers={"Retry-After": "0"}, stream=retry_body)
        return httpx.Response(200, stream=body)

    async def sleep(delay):
        assert retry_body.closed is True
        sleeps.append(delay)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncVistaLink("vl_test_abc", base_url="https://api.test", http_client=http, max_retries=1, sleep=sleep)
    try:
        stream = client.jobs.result_stream("job_1")
        assert await anext(stream) == b'{"hotel_id":"h1"}\n'
        assert len(calls) == 2
        assert sleeps == [0.0]
        await stream.aclose()
    finally:
        await http.aclose()


async def test_async_result_stream_closes_body_before_retrying_first_read_failure():
    failed_body = BrokenAsync()
    good_body = ChunkedAsync()
    calls = []
    sleeps = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200, stream=failed_body)
        return httpx.Response(200, stream=good_body)

    async def sleep(delay):
        assert failed_body.closed is True
        sleeps.append(delay)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncVistaLink("vl_test_abc", base_url="https://api.test", http_client=http, max_retries=1, sleep=sleep)
    try:
        stream = client.jobs.result_stream("job_1")
        assert await anext(stream) == b'{"hotel_id":"h1"}\n'
        assert failed_body.read_started is True
        assert len(calls) == 2
        assert len(sleeps) == 1
        await stream.aclose()
    finally:
        await http.aclose()


async def test_async_signed_non_success_does_not_read_broken_error_body():
    body = BrokenAsync()
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(403, stream=body)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncVistaLink("vl_test_abc", base_url="https://api.test", http_client=http, max_retries=3)
    job_model = models.Job.model_validate(job("succeeded", result_url="https://files.test/r.ndjson"))
    try:
        stream = client.jobs.download_stream(job_model)
        with pytest.raises(VistaLinkError) as exc:
            await anext(stream)
        assert (exc.value.code, exc.value.status) == ("upstream_error", 403)
        assert body.read_started is False
        assert body.closed is True
        assert len(calls) == 1
    finally:
        await http.aclose()
