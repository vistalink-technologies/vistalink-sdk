import pytest

from vistalink import VistaLink, WebhookVerificationError, webhooks

# Vector produced by the API server's own webhook signer.
SECRET = "whsec_test_123"
BODY = b'{"created_at":"2026-10-07T12:00:00Z","data":{"job_id":"job_abc","status":"succeeded"},"event":"rates.completed","id":"evt_1"}'
T = 1791374400
HEADER = f"t={T},v1=48227c59b496d7b1365cb76b40bb17f7a055a21ea28b2865f511b336a7c36168"


def test_verify_accepts_server_signature():
    event = webhooks.verify(SECRET, {"X-VistaLink-Signature": HEADER}, BODY, now=T + 10)
    assert event["event"] == "rates.completed" and event["data"]["job_id"] == "job_abc"
    assert webhooks.verify(SECRET, {"x-vistalink-signature": [HEADER]}, BODY.decode(), now=T)
    assert VistaLink("k").webhooks.verify(SECRET, HEADER, BODY, now=T)


@pytest.mark.parametrize("secret,header,body,msg", [
    (SECRET, HEADER, BODY.replace(b"succeeded", b"failed"), "mismatch"),
    ("whsec_other", HEADER, BODY, "mismatch"),
    (SECRET, None, BODY, "Missing"),
    (SECRET, "v1=abc", BODY, "Malformed"),
])
def test_verify_rejects(secret, header, body, msg):
    headers = {} if header is None else {"X-VistaLink-Signature": header}
    with pytest.raises(WebhookVerificationError, match=msg):
        webhooks.verify(secret, headers, body, now=T)


def test_tolerance_is_five_minutes():
    assert webhooks.verify(SECRET, HEADER, BODY, now=T + 300)
    for now in (T + 301, T - 301):
        with pytest.raises(WebhookVerificationError, match="tolerance"):
            webhooks.verify(SECRET, HEADER, BODY, now=now)
    assert webhooks.verify(SECRET, HEADER, BODY, now=T + 1000, tolerance=2000)


def test_sign_round_trip():
    assert webhooks.sign(SECRET, BODY, T) == HEADER
