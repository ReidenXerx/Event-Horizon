#!/usr/bin/env python3
"""
Count lines of code in a git repository, by rules anyone can audit.

    python loc.py [repo_dir] [--json OUT] [--by-lang]

CANONICAL COPY: nexus-tools/scripts/loc.py. Each mod repo carries a copy for its CI,
because a CI job can only run what is in its own checkout. Keep them identical.

WHY NOT A THIRD-PARTY COUNTER. shields.io removed its lines-of-code badge (it returns
"404 badge not found"), and GitHub's language statistics are BYTES of every tracked
file - including generated output. On Rapport that counted a 121 KB generated HTML
page as if it were source. A published number a sceptic can deflate with `cloc` does
more harm than having no number at all, so the rules are explicit and deliberately
conservative:

  - only files git TRACKS (`git ls-files`): nothing untracked, nothing ignored
  - blank lines do not count, and neither do lines that are only a comment
  - vendored and generated paths are excluded (EXCLUDE_DIRS / EXCLUDE_FILES below)
  - agent tooling that ships with the workspace kit (bearing, gitnexus, .claude) is not
    the project's own code, and is excluded

It undercounts rather than overcounts: a line with code and a trailing comment counts
once, and a docstring counts as a comment.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys

LANGS = {
    ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".h": "C++", ".hpp": "C++", ".inl": "C++",
    ".psc": "Papyrus",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
    ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
    ".py": "Python", ".ps1": "PowerShell", ".psm1": "PowerShell", ".sh": "Shell",
}

EXCLUDE_DIRS = {
    "extern", "vendor", "third_party", "node_modules", "build", "dist", "out", "coverage",
    "lib-cov", ".git", ".bearing", ".gitnexus", ".claude", ".cursor", ".agents",
    "voice",       # rendered audio + generated pages in the mod repos
    "papyrus-stubs",
}
# Tooling files that belong to the workspace kit rather than the project.
EXCLUDE_FILES = re.compile(r"(^|/)(bearing[-_][^/]*|gitnexus[-_][^/]*)$", re.I)
GENERATED = re.compile(r"\.min\.(js|css)$|\.generated\.|\.d\.ts$", re.I)

C_LIKE = {"C++", "TypeScript", "JavaScript"}


def tracked(repo: pathlib.Path):
    out = subprocess.run(["git", "-C", str(repo), "ls-files", "-z"],
                         capture_output=True, check=True).stdout.decode("utf-8", "replace")
    for rel in filter(None, out.split("\0")):
        parts = rel.split("/")
        if any(p in EXCLUDE_DIRS for p in parts[:-1]):
            continue
        if EXCLUDE_FILES.search(rel) or GENERATED.search(rel):
            continue
        ext = pathlib.PurePosixPath(rel).suffix.lower()
        if ext in LANGS:
            yield rel, LANGS[ext]


def code_lines(text: str, lang: str) -> int:
    n, in_block = 0, None
    for raw in text.splitlines():
        s = raw.strip()
        if in_block:
            # Code after the closer on the same line is not counted: undercount,
            # never overcount.
            if in_block in s:
                in_block = None
            continue
        if not s:
            continue
        if lang in C_LIKE:
            if s.startswith("//"):
                continue
            if s.startswith("/*"):
                if "*/" not in s[2:]:
                    in_block = "*/"
                continue
        elif lang == "Papyrus":
            if s.startswith(";/"):
                if "/;" not in s[2:]:
                    in_block = "/;"
                continue
            if s.startswith(";"):
                continue
            if s.startswith("{"):
                if "}" not in s[1:]:
                    in_block = "}"
                continue
        elif lang == "Python":
            if s.startswith("#"):
                continue
            for q in ('"""', "'''"):
                if s.startswith(q):
                    if s.count(q) == 1:
                        in_block = q
                    break
            else:
                n += 1
            continue
        elif lang == "PowerShell":
            if s.startswith("<#"):
                if "#>" not in s[2:]:
                    in_block = "#>"
                continue
            if s.startswith("#"):
                continue
        elif lang == "Shell":
            if s.startswith("#"):
                continue
        n += 1
    return n


def count(repo: pathlib.Path):
    per = {}
    files = 0
    for rel, lang in tracked(repo):
        try:
            text = (repo / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        per[lang] = per.get(lang, 0) + code_lines(text, lang)
        files += 1
    return per, files


def human(n: int) -> str:
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("repo", nargs="?", default=".")
    ap.add_argument("--json", metavar="OUT", help="write a shields.io endpoint JSON")
    ap.add_argument("--label", default="code")
    a = ap.parse_args()
    repo = pathlib.Path(a.repo).resolve()
    per, files = count(repo)
    total = sum(per.values())
    for lang, n in sorted(per.items(), key=lambda kv: -kv[1]):
        print(f"  {lang:11} {n:8,}")
    print(f"  {'TOTAL':11} {total:8,}   ({files} files)")
    if a.json:
        top = [f"{human(n)} {lang}" for lang, n in sorted(per.items(), key=lambda kv: -kv[1])[:2]]
        badge = {"schemaVersion": 1, "label": a.label,
                 "message": f"{human(total)} lines", "color": "informational",
                 "_breakdown": per, "_files": files, "_top": top}
        p = pathlib.Path(a.json)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(badge, indent=2), encoding="utf-8")
        print(f"  badge -> {p}  ({badge['message']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
