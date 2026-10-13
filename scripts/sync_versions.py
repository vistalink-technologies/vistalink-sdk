#!/usr/bin/env python3
"""Keep SDK versions in step with the spec.

Policy: SDK major.minor = spec ``info.version`` major.minor. The patch number
is the SDKs' own (fixes that do not change the API), and goes back to 0 when
the spec's major.minor moves. Writes every place the version lives.

    python3 scripts/sync_versions.py                  # apply
    python3 scripts/sync_versions.py --check          # exit 1 if anything would change
    python3 scripts/sync_versions.py --reserve        # pin every package to 0.0.1
    python3 scripts/sync_versions.py --reserve 0.0.2  # pin to another 0.0.x
    python3 scripts/sync_versions.py --unpin          # drop the pin, follow the spec again

Pin: while ``scripts/VERSION_PIN`` exists, its contents are the version for
all six places, and the spec rule is suspended (so a plain run or the nightly
spec-sync cannot bump a 0.0.x name reservation back to 2.0.0). ``--reserve``
writes the pin; ``--unpin`` deletes it and re-applies the spec rule, which
moves 0.0.x to the spec's major.minor with patch 0.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / "spec/openapi.v2.json").read_text())
PIN = ROOT / "scripts/VERSION_PIN"
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")

FILES = {
    "packages/typescript/package.json": r'("version":\s*")([^"]+)(")',
    "packages/cli/package.json": r'("version":\s*")([^"]+)(")',
    "packages/vistalink-unscoped/package.json": r'("version":\s*")([^"]+)(")',
    "packages/python/pyproject.toml": r'(^version\s*=\s*")([^"]+)(")',
    "packages/typescript/src/client.ts": r'(SDK_VERSION = ")([^"]+)(")',
    "packages/python/src/vistalink/_base.py": r'(__version__ = ")([^"]+)(")',
}


def pinned() -> str | None:
    if not PIN.exists():
        return None
    v = PIN.read_text().strip()
    if not SEMVER.match(v):
        raise SystemExit(f"{PIN.relative_to(ROOT)}: not a plain x.y.z version: {v!r}")
    return v


def target(current: str) -> str:
    pin = pinned()
    if pin:
        return pin
    smaj, smin = SPEC["info"]["version"].split(".")[:2]
    cmaj, cmin, cpatch = (current.split(".") + ["0", "0"])[:3]
    if (cmaj, cmin) == (smaj, smin):
        return f"{smaj}.{smin}.{cpatch}"
    return f"{smaj}.{smin}.0"


def main() -> int:
    args = sys.argv[1:]
    check = "--check" in args
    if "--reserve" in args:
        i = args.index("--reserve")
        v = args[i + 1] if i + 1 < len(args) and not args[i + 1].startswith("-") else "0.0.1"
        if not SEMVER.match(v):
            raise SystemExit(f"--reserve: not a plain x.y.z version: {v!r}")
        if not check:
            PIN.write_text(v + "\n")
            print(f"pinned {v} in {PIN.relative_to(ROOT)}")
    if "--unpin" in args and PIN.exists() and not check:
        PIN.unlink()
        print(f"removed {PIN.relative_to(ROOT)}; versions follow the spec again")
    changed = []
    for rel, pattern in FILES.items():
        path = ROOT / rel
        text = path.read_text()
        m = re.search(pattern, text, re.M)
        if not m:
            raise SystemExit(f"no version found in {rel}")
        new = target(m.group(2))
        if new != m.group(2):
            changed.append(f"{rel}: {m.group(2)} -> {new}")
            if not check:
                path.write_text(text[: m.start(2)] + new + text[m.end(2):])
    for line in changed:
        print(line)
    if not changed:
        pin = pinned()
        print(f"versions pinned at {pin} ({PIN.relative_to(ROOT)})" if pin
              else f"versions in step with spec {SPEC['info']['version']}")
    return 1 if (check and changed) else 0


if __name__ == "__main__":
    sys.exit(main())
