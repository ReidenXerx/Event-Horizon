#!/usr/bin/env python3
"""
Turn a vitest JSON report into a shields.io endpoint badge, and fail if the suite did.

    python scripts/vitest-badge.py out/vitest.json out/badges/tests.json

CANONICAL COPY: nexus-tools/scripts/vitest-badge.py.

The badge and the job status must not be able to disagree. This writes "N passing" in
green only when every test passed, "N failing" in red otherwise - and it exits non-zero
in that case, so the CI run goes red too. A badge that stays green while the job is red
(or the reverse) is worse than no badge.

A missing or unreadable report is itself a failure: "no report" is not "no failures".
"""
import json
import pathlib
import sys


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: vitest-badge.py <vitest.json> <out.json>")
    rep, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = json.loads(rep.read_text(encoding="utf-8"))
        total = int(r["numTotalTests"])
        failed = int(r["numFailedTests"])
        passed = int(r["numPassedTests"])
        skipped = int(r.get("numPendingTests", 0)) + int(r.get("numTodoTests", 0))
    except Exception as e:  # no report means the run itself broke
        badge = {"schemaVersion": 1, "label": "tests", "message": "no report",
                 "color": "red", "isError": True}
        out.write_text(json.dumps(badge, indent=2), encoding="utf-8")
        print(f"no usable vitest report: {e}")
        return 1

    ok = failed == 0 and passed > 0 and r.get("success", False)
    msg = f"{passed:,} passing" if ok else f"{failed:,} failing of {total:,}"
    if ok and skipped:
        msg += f", {skipped:,} skipped"
    badge = {"schemaVersion": 1, "label": "tests", "message": msg,
             "color": "brightgreen" if ok else "red", "isError": not ok,
             "_total": total, "_passed": passed, "_failed": failed, "_skipped": skipped}
    out.write_text(json.dumps(badge, indent=2), encoding="utf-8")
    print(f"tests badge: {msg}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
