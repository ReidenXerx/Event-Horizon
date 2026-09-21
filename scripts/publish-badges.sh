#!/usr/bin/env bash
# Publish every *.json in a directory to the repo's `badges` branch.
#
#   bash scripts/publish-badges.sh out/badges
#
# CANONICAL COPY: nexus-tools/scripts/publish-badges.sh. Each repo carries a copy for its
# CI, because a job can only run what is in its own checkout.
#
# WHY A SEPARATE BRANCH. The badges on the Nexus pages read shields.io endpoint JSON from
#   https://raw.githubusercontent.com/<owner>/<repo>/badges/<name>.json
# Committing those files back to master on every push would double the commit history,
# and the workspace's index-staleness check counts commits behind HEAD, so it would trip
# for everyone working in the repo on every single push. An orphan branch holds only the
# JSON, never touches master, and is invisible to anyone not looking for it.
set -euo pipefail
src="${1:?usage: publish-badges.sh <dir-with-json>}"
shopt -s nullglob
files=("$src"/*.json)
if [ ${#files[@]} -eq 0 ]; then echo "no badge json in $src"; exit 1; fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

stash="$(mktemp -d)"
cp "${files[@]}" "$stash"/

if git ls-remote --exit-code --heads origin badges >/dev/null 2>&1; then
  git fetch --quiet --depth 1 origin badges
  git checkout --quiet -B badges FETCH_HEAD
else
  git checkout --quiet --orphan badges
  git rm -rfq . >/dev/null 2>&1 || true
fi

cp "$stash"/*.json .
git add ./*.json
if git diff --cached --quiet; then
  echo "badges unchanged"
  exit 0
fi
git commit -q -m "badges for ${GITHUB_SHA:0:7} [skip ci]"
git push --quiet origin badges
echo "published: $(cd "$stash" && ls *.json | tr '\n' ' ')"
