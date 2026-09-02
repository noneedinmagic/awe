#!/usr/bin/env bash
# Move `live` to the current green tip of main and record it as live-history/<n>.
# Called by ci.yml's retag job; runnable by hand when the pipeline is down.
#   scripts/retag-live.sh            # tag origin/main tip
#   scripts/retag-live.sh <sha>      # tag <sha>, refused unless it IS the tip
#
# Testing a change to this script safely (#247): it pushes to a real remote by default.
# Point REMOTE at a fake/local remote to keep it off `origin` entirely, and/or set
# DRY_RUN=1 to print the push commands instead of running them (fetch/tag stay local
# either way, so a dry run still lets you inspect the tag it would have pushed):
#   REMOTE=test-remote DRY_RUN=1 scripts/retag-live.sh
set -euo pipefail

remote="${REMOTE:-origin}"

# A shallow clone undercounts `git rev-list --count`, producing a misnamed
# live-history/<n> tag. CI guards this with fetch-depth: 0; by-hand runs must too.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "refusing to run on a shallow clone (git rev-list --count would undercount)" >&2
  exit 1
fi

git fetch --quiet "$remote" main
tip=$(git rev-parse "$remote/main")
target="${1:-$tip}"

# Refuse anything but the tip. In CI this stops a re-run of an OLD main run from
# moving `live` BACKWARD across the whole fleet, silently, with a green check.
# By hand it stops a stale checkout from doing the same thing. Rollback to an
# older state is a deliberate, separate act — see docs/adr/0004 — not this script.
if [ "$target" != "$tip" ]; then
  echo "not moving live: $target is not $remote/main tip ($tip)" >&2
  exit 0
fi

n=$(git rev-list --count "$target")
git tag -f "live-history/$n" "$target"
git tag -f live "$target"

run() {
  if [ "${DRY_RUN:-}" = "1" ]; then
    echo "DRY_RUN: $*"
  else
    "$@"
  fi
}

# History tag pushed separately, non-forced: an accidental re-point of an
# already-recorded SHA is rejected rather than silently overwritten. Pushed
# BEFORE the live push, so a rejection here (a genuine anomaly — the tip guard
# above makes it very hard to hit in the normal path) can never block `live`
# from moving. It is only the history record that's at risk, never the fleet.
run git push "$remote" "refs/tags/live-history/$n" || \
  echo "warning: live-history/$n push failed (probably already exists at a different SHA) — live will still move" >&2

run git push --force "$remote" "refs/tags/live"

echo "live -> $target (live-history/$n) on $remote${DRY_RUN:+ [dry-run]}"
