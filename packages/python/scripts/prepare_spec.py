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

    python scripts/prepare_spec.py IN.json OUT.json
"""
import json
import sys

SCALARS = {"string", "integer", "number", "boolean", "array"}
PLAIN_STRING_FORMATS = {"uuid", "uri", "email"}


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
        json.dump(walk(doc), fh, indent=1)
