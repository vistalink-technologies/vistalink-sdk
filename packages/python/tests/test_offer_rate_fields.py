"""API 2.3.0 and later: the Offer rate fields are typed, optional, and parse the spec's own example."""
import json
from pathlib import Path

from vistalink import models

SPEC = json.loads((Path(__file__).resolve().parents[3] / "spec" / "openapi.v2.json").read_text())

FIELDS = ("rate_plan_code", "base_total", "tax_total", "fee_total", "taxes", "fees", "rooms_left",
          "guarantee_required", "cancellation_type", "cancellation_deadline_local", "hotel_timezone",
          "cancellation_penalties", "cancellation_policy")


def test_spec_version_and_fields():
    major, minor = (int(x) for x in SPEC["info"]["version"].split(".")[:2])
    assert (major, minor) >= (2, 3), SPEC["info"]["version"]
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
    assert offer.cancellation_deadline_local == "2027-05-12T18:00:00" and offer.hotel_timezone == "Europe/Rome"
    assert offer.cancellation_penalties[0].nights == 1.0
    assert offer.guarantee_required is True


def test_an_offer_from_before_2_3_still_parses():
    old = {"offer_id": "off_t0123456789abcdef0123", "channel": "direct", "total": "962.00", "currency": "EUR"}
    offer = models.Offer.model_validate(old)
    for name in FIELDS:
        assert getattr(offer, name) is None, name


def test_additive_response_vocabularies_are_open():
    """The API adds reason codes and match bases without a new major. A closed Literal made
    model_validate reject the whole response the day one arrived (2026-11-25 review)."""
    r = models.RateResult.model_validate(
        {"input": 0, "status": "unresolved", "reason": "a_reason_from_the_future", "channel": "direct"})
    assert r.reason == "a_reason_from_the_future"
    res = models.ResolveResult.model_validate(
        {"input": 0, "status": "resolved", "hotel_id": "43d0be71-5f0e-4f1e-9a51-2b7b3c4d5e6f",
         "match": "exact", "basis": "a_basis_from_the_future"})
    assert res.basis == "a_basis_from_the_future"
    assert models.ResolveResult.model_validate({"input": 0, "status": "unresolved", "reason": "ambiguous_name"})
    # the known values are still documented on the field
    assert "`engine_timeout`" in models.RateResult.model_fields["reason"].description
    # closed vocabularies stay closed: a status the API does not have is still an error
    import pydantic
    import pytest

    with pytest.raises(pydantic.ValidationError):
        models.RateResult.model_validate({"input": 0, "status": "maybe", "channel": "direct"})


def test_request_enums_stay_closed():
    import pydantic
    import pytest

    with pytest.raises(pydantic.ValidationError):
        models.RatesRequest.model_validate({"hotels": ["43d0be71-5f0e-4f1e-9a51-2b7b3c4d5e6f"],
                                            "stay": {"check_in": "2027-05-14", "check_out": "2027-05-16"},
                                            "freshness": "sometimes"})


def test_engine_code_identifier_is_typed():
    """API 2.4.0: a hotel can be named by its booking-engine code."""
    ident = models.HotelIdentifier.model_validate({"engine": "SYNXIS", "chain_code": "24876", "engine_hotel_id": "7389"})
    assert ident.model_dump(exclude_none=True) == {"engine": "SYNXIS", "chain_code": "24876", "engine_hotel_id": "7389"}


def test_penalty_nights_is_an_integer():
    """API 2.5.0: `CancellationPenalty.nights` is a whole number."""
    pen = models.CancellationPenalty.model_validate({"nights": 1})
    assert pen.nights == 1 and type(pen.nights) is int
