"""Normalise the OpenAPI document before datamodel-codegen.

pydantic emits ``anyOf: [{type: string, maxLength: 10}, {type: null}]`` for
optional constrained scalars; datamodel-codegen turns each into a RootModel
(``Locale1``) that IDEs then demand instead of a plain ``str``. Rewriting them
as ``{type: [string, null], maxLength: 10}`` yields ``str | None`` fields with
the same constraints.

String formats ``uuid``, ``uri`` and ``email`` are dropped so ids, URLs and
emails stay plain ``str`` (as the API sends them): pydantic's ``AnyUrl``
rewrites URLs (``https://umilta36.com`` → ``https://umilta36.com/``), which
breaks round-tripping identifiers, and ``EmailStr`` needs the extra
``email-validator`` package. The server validates them. ``date`` and
``date-time`` are kept (``date`` / ``AwareDatetime``).

**Open enums.** The API adds values to some response vocabularies without a
new major (its additive-change policy: ``reason`` codes, failure reasons, the
``basis`` of a match, job kinds). Generated as closed ``Literal`` types, such a
field makes ``model_validate`` reject the WHOLE response the day the API sends
a value this SDK build has never seen. So the enum is dropped from those
fields and they become plain ``str``; the values known at build time are
listed in the field's description. A field is open when the spec marks it
``x-vistalink-open-enum: true``, or when its name is in ``OPEN_ENUM_FIELDS``
(for specs published before the marker existed).

    python scripts/prepare_spec.py IN.json OUT.json
"""
import json
import sys

SCALARS = {"string", "integer", "number", "boolean", "array"}
PLAIN_STRING_FORMATS = {"uuid", "uri", "email"}
OPEN_ENUM_MARK = "x-vistalink-open-enum"
OPEN_ENUM_FIELDS = {"reason", "no_price_reason", "failure_reason", "basis", "resolved_basis", "kind"}


def _open(schema):
    """``schema`` with its string enum removed (directly or inside an anyOf); the values go to the description."""
    values = []

    def strip(node):
        if isinstance(node, dict):
            if node.get("type") == "string" and isinstance(node.get("enum"), list):
                values.extend(v for v in node["enum"] if isinstance(v, str))
                node = {k: v for k, v in node.items() if k != "enum"}
            if isinstance(node.get("anyOf"), list):
                node = {**node, "anyOf": [strip(x) for x in node["anyOf"]]}
        return node

    out = strip(dict(schema))
    if not values:
        return schema
    known = "Values known when this SDK was built: " + ", ".join(f"`{v}`" for v in dict.fromkeys(values)) + \
        ". The API may add values; treat one you do not know as \"other\"."
    out["description"] = (out.get("description", "").rstrip() + " " + known).strip()
    out.pop(OPEN_ENUM_MARK, None)
    return out


def open_enums(node, in_response=True):
    """Open the marked or named enum fields of every object schema."""
    if isinstance(node, list):
        return [open_enums(x) for x in node]
    if not isinstance(node, dict):
        return node
    node = {k: open_enums(v) for k, v in node.items()}
    props = node.get("properties")
    # Request bodies forbid unknown keys and are validated by the server: their enums stay closed, so a
    # typo is caught before the request is sent.
    if isinstance(props, dict) and node.get("additionalProperties") is not False:
        node["properties"] = {
            name: (_open(schema) if isinstance(schema, dict)
                   and (schema.get(OPEN_ENUM_MARK) is True or name in OPEN_ENUM_FIELDS) else schema)
            for name, schema in props.items()}
    return node


def walk(node):
    if isinstance(node, list):
        return [walk(x) for x in node]
    if not isinstance(node, dict):
        return node
    node = {k: walk(v) for k, v in node.items()}
    if node.get("format") in PLAIN_STRING_FORMATS:
        del node["format"]
    any_of = node.get("anyOf")
    if isinstance(any_of, list) and len(any_of) == 2:
        nulls = [x for x in any_of if x == {"type": "null"}]
        others = [x for x in any_of if x != {"type": "null"}]
        if len(nulls) == 1 and len(others) == 1:
            other = others[0]
            if other.get("type") in SCALARS and "enum" not in other and "$ref" not in other:
                merged = {k: v for k, v in node.items() if k != "anyOf"}
                merged.update({k: v for k, v in other.items() if k != "type"})
                merged["type"] = [other["type"], "null"]
                return merged
    return node


if __name__ == "__main__":
    with open(sys.argv[1]) as fh:
        doc = json.load(fh)
    with open(sys.argv[2], "w") as fh:
        json.dump(walk(open_enums(doc)), fh, indent=1)
