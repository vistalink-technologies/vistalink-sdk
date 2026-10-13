import pytest
import respx

from vistalink import AsyncVistaLink, VistaLink

BASE = "https://api.test"


def job(status, **extra):
    return {"job_id": "job_1", "kind": "rates.live", "status": status, "created_at": "2026-10-07T12:00:00Z",
            "updated_at": "2026-10-07T12:00:01Z", "progress": {"done": 0, "total": 1}, **extra}


def booking(status, **extra):
    return {"booking_id": "bk_1", "status": status, "hotel_id": "h1", **extra}


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def vl(sleeps):
    with respx.mock(base_url=BASE, assert_all_called=False) as router:
        client = VistaLink("vl_test_abc", base_url=BASE, sleep=sleeps.append)
        client.router = router
        yield client
        client.close()


@pytest.fixture
async def avl(sleeps):
    async def _sleep(s):
        sleeps.append(s)

    with respx.mock(base_url=BASE, assert_all_called=False) as router:
        client = AsyncVistaLink("vl_test_abc", base_url=BASE, sleep=_sleep)
        client.router = router
        yield client
        await client.aclose()
