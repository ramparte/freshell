#!/usr/bin/env bash
# collect-baseline.sh <analysis-worktree-triage-output-dir> [main-ref]
#
# Collect per-worktree git metrics for every worktree under <repo>/.worktrees/
# and write JSONL (one record per worktree) to <out-dir>/baseline-data.jsonl.
#
# Designed to be squash-merge aware: in addition to the ancestor check it
# records footprintFiles (files the branch touched since the merge-base) and
# footprintDiffersVsMain (of those, how many differ between the branch tip and
# the current main tree). A squash-merged branch is never an ancestor, but its
# footprint difference is small (often <=3 files of post-merge evolution).
#
# Detached-HEAD worktrees are first-class: they report branch="DETACHED" and
# usually show ancestor=YES/ahead=0 when their commit landed.
#
# Read-only. Safe to run repeatedly.
set -uo pipefail

OUT_DIR="${1:?usage: collect-baseline.sh <triage-output-dir> [main-ref]}"
MAIN="${2:-origin/main}"
ROOT="$(git rev-parse --show-toplevel)"
OUT="$OUT_DIR/baseline-data.jsonl"
mkdir -p "$OUT_DIR"
: > "$OUT"

git -C "$ROOT" fetch --quiet origin "$(git -C "$ROOT" rev-parse --abbrev-ref "$MAIN" 2>/dev/null || echo main)" 2>/dev/null || true

SELF="$(cd "$OUT_DIR/.." && pwd)"   # the analysis worktree itself
git -C "$ROOT" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | while read -r wt; do
  case "$wt" in
    "$ROOT") continue ;;      # skip main checkout
    "$SELF") continue ;;      # skip analysis worktree
  esac
  name=$(basename "$wt")
  case "$name" in
    .*) continue ;;           # skip hidden/transient scratch worktrees (e.g. .base-gate-$$)
  esac
  head=$(git -C "$wt" rev-parse HEAD 2>/dev/null || echo "?")
  branch=$(git -C "$wt" symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")
  date=$(git -C "$wt" log -1 --format=%cs 2>/dev/null || echo "?")
  if git merge-base --is-ancestor "$head" "$MAIN" 2>/dev/null; then anc=YES; else anc=NO; fi
  ahead=$(git rev-list --count "$MAIN..$head" 2>/dev/null || echo "?")
  behind=$(git rev-list --count "$head..$MAIN" 2>/dev/null || echo "?")
  status=$(git -C "$wt" status --porcelain 2>/dev/null)
  dirty=$(printf '%s' "$status" | grep -c . || true)
  dirtysample=$(printf '%s' "$status" | head -3 | paste -sd';' | cut -c1-160)
  # squash-merge detection: branch footprint vs main
  mb=$(git merge-base "$MAIN" "$head" 2>/dev/null || echo "")
  touched=0; differ=0
  if [ -n "$mb" ]; then
    tfiles=$(git diff --name-only "$mb..$head" 2>/dev/null)
    touched=$(printf '%s' "$tfiles" | grep -c . || true)
    if [ "$touched" -gt 0 ]; then
      differ=$(git diff --name-only "$head" "$MAIN" -- $tfiles 2>/dev/null | grep -c . || true)
    fi
  fi
  python3 -c '
import json,sys
name,branch,head,date,anc,ahead,behind,dirty,dirtysample,touched,differ,wt = sys.argv[1:13]
print(json.dumps({"name":name,"branch":branch,"head":head[:9],"date":date,"ancestor":anc,
 "ahead":int(ahead) if ahead.isdigit() else ahead,"behind":int(behind) if behind.isdigit() else behind,
 "dirty":int(dirty),"dirtySample":dirtysample,"footprintFiles":int(touched),"footprintDiffersVsMain":int(differ),
 "path":wt}))
' "$name" "$branch" "$head" "$date" "$anc" "$ahead" "$behind" "$dirty" "$dirtysample" "$touched" "$differ" "$wt" >> "$OUT"
done
echo "collected $(wc -l < "$OUT") records -> $OUT"
