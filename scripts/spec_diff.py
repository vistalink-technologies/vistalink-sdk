#!/usr/bin/env python3
"""Structural diff of two OpenAPI 3.1 documents.

Schema *names* differ freely between a hand-authored and a generated spec, so
this dereferences every operation's parameters, request body and responses and
compares the flattened shapes (JSON path -> type/enum/required/format).

    python3 scripts/spec_diff.py OLD.json NEW.json [--markdown]
Exit code 0 = no structural differences, 1 = differences.
"""
import json
import sys

METHODS = ("get", "post", "put", "patch", "delete")


def load(path):
    with open(path) as fh:
        return json.load(fh)


def resolve(doc, node, seen=()):
    if isinstance(node, dict) and "$ref" in node:
        ref = node["$ref"]
        if ref in seen:
            return {"type": "<recursive " + ref.rsplit("/", 1)[-1] + ">"}
        target = doc
        for part in ref.lstrip("#/").split("/"):
            target = target[part]
        merged = {**target, **{k: v for k, v in node.items() if k != "$ref"}}
        return resolve(doc, merged, seen + (ref,))
    return node


def describe(doc, schema, seen=()):
    """Short signature of a leaf schema."""
    s = resolve(doc, schema, seen)
    for key in ("anyOf", "oneOf"):
        if key in s:
            parts = sorted({describe(doc, x, seen) for x in s[key]})
            return " | ".join(parts)
    t = s.get("type", "object" if "properties" in s else "any")
    if isinstance(t, list):
        t = " | ".join(t)
    if "enum" in s:
        return f"{t} enum[{', '.join(map(str, s['enum']))}]"
    if "const" in s:
        return f"const {s['const']}"
    if t == "array":
        return "array<" + describe(doc, s.get("items", {}), seen) + ">"
    fmt = s.get("format")
    return f"{t}({fmt})" if fmt else t


def flatten(doc, schema, prefix, out, seen=(), depth=0):
    if depth > 40:
        return
    if isinstance(schema, dict) and "$ref" in schema:
        if schema["$ref"] in seen:
            return
        seen = seen + (schema["$ref"],)
    s = resolve(doc, schema)
    out[prefix] = describe(doc, schema)
    variants = s.get("anyOf") or s.get("oneOf") or s.get("allOf")
    if variants:
        merged = {}
        for v in variants:
            part = {}
            flatten(doc, v, prefix, part, seen, depth + 1)
            for k, val in part.items():
                if k in merged and merged[k] != val:
                    merged[k] = " | ".join(sorted(set(merged[k].split(" | ")) | set(val.split(" | "))))
                else:
                    merged.setdefault(k, val)
        out.update(merged)
        out[prefix] = describe(doc, schema)
    required = set(s.get("required", []))
    for name, sub in (s.get("properties") or {}).items():
        flag = "" if name in required else "?"
        flatten(doc, sub, f"{prefix}.{name}{flag}", out, seen, depth + 1)
    if s.get("type") == "array" and "items" in s:
        flatten(doc, s["items"], prefix + "[]", out, seen, depth + 1)


def op_shapes(doc):
    shapes = {}
    for path, item in doc.get("paths", {}).items():
        for method in METHODS:
            op = item.get(method)
            if not op:
                continue
            key = f"{method.upper()} {path}"
            flat = {}
            for p in item.get("parameters", []) + op.get("parameters", []):
                p = resolve(doc, p)
                req = "" if p.get("required") else "?"
                flat[f"param.{p['in']}.{p['name']}{req}"] = describe(doc, p.get("schema", {}))
            body = resolve(doc, op.get("requestBody", {})) if op.get("requestBody") else None
            if body:
                for ctype, media in body.get("content", {}).items():
                    flatten(doc, media.get("schema", {}), "body", flat)
            for code, resp in op.get("responses", {}).items():
                resp = resolve(doc, resp)
                content = resp.get("content", {})
                if not content:
                    flat[f"response.{code}"] = "(no body)"
                for ctype, media in content.items():
                    flatten(doc, media.get("schema", {}), f"response.{code}", flat)
            for ext in sorted(k for k in op if k.startswith("x-")):
                flat[ext] = json.dumps(op[ext], sort_keys=True)
            flat["security"] = json.dumps(op.get("security", doc.get("security")), sort_keys=True)
            shapes[key] = flat
    return shapes


def diff(old, new):
    a, b = op_shapes(old), op_shapes(new)
    lines = []
    for key in sorted(set(a) - set(b)):
        lines.append(("op", key, "only in OLD", "", ""))
    for key in sorted(set(b) - set(a)):
        lines.append(("op", key, "only in NEW", "", ""))
    for key in sorted(set(a) & set(b)):
        fa, fb = a[key], b[key]
        for f in sorted(set(fa) | set(fb)):
            va, vb = fa.get(f), fb.get(f)
            if va != vb:
                lines.append(("field", key, f, va or "—", vb or "—"))
    return lines


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    old, new = load(argv[1]), load(argv[2])
    lines = diff(old, new)
    md = "--markdown" in argv
    current = None
    for kind, key, what, va, vb in lines:
        if kind == "op":
            print(f"- **{key}** — {what}" if md else f"{key}: {what}")
            continue
        if md and key != current:
            print(f"\n### {key}\n\n| field | old | new |\n|---|---|---|")
            current = key
        if md:
            print(f"| `{what}` | {str(va).replace('|', '/')} | {str(vb).replace('|', '/')} |")
        else:
            print(f"{key}  {what}: {va} -> {vb}")
    return 1 if lines else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
