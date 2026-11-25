"""API 2.3.0: the Offer rate fields are typed, optional, and parse the spec's own example."""
import json
from pathlib import Path

from vistalink import models

SPEC = json.loads((Path(__file__).resolve().parents[3] / "spec" / "openapi.v2.json").read_text())

FIELDS = ("rate_plan_code", "base_total", "tax_total", "fee_total", "taxes", "fees", "rooms_left",
          "guarantee_required", "cancellation_type", "cancellation_deadline_local", "hotel_timezone",
          "cancellation_penalties", "cancellation_policy")


def test_spec_version_and_fields():
    assert SPEC["info"]["version"].startswith("2.3.")
    props = SPEC["components"]["schemas"]["Offer"]["properties"]
    for name in FIELDS:
        assert name in props, name
        assert name in models.Offer.model_fields, name
        assert not models.Offer.model_fields[name].is_required(), name


def test_the_spec_example_parses_with_every_field():
    example = SPEC["components"]["schemas"]["Offer"]["examples"][0]
    offer = models.Offer.model_validate(example)
    assert offer.rate_plan_code == "FLEXBB" and offer.rooms_left == 3
    assert (offer.base_total, offer.tax_total, offer.fee_total) == ("860.00", "86.00", "16.00")
    assert offer.taxes[0].code == "VAT" and offer.fees[0].name == "City tax"
    assert offer.cancellation_deadline_local == "2026-11-12T18:00:00" and offer.hotel_timezone == "Europe/Rome"
    assert offer.cancellation_penalties[0].nights == 1.0
    assert offer.guarantee_required is True


def test_an_offer_from_before_2_3_still_parses():
    old = {"offer_id": "off_t0123456789abcdef0123", "channel": "direct", "total": "962.00", "currency": "EUR"}
    offer = models.Offer.model_validate(old)
    for name in FIELDS:
        assert getattr(offer, name) is None, name
