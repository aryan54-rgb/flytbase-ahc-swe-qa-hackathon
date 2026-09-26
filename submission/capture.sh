#!/usr/bin/env bash
# Final submission capture: runs each scenario ONCE, individually, against the clean app (no mutation,
# no LLM provider), then copies its real Playwright recording + evidence into submission/.
# Refuses to overwrite existing final files unless FORCE=1.
#
#   bash submission/capture.sh            (from the repository root, stack running)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUB="$ROOT/submission"
QA="$ROOT/qa"

SCENARIOS=(
  "001 device-integrity"
  "002 selection-sync"
  "003 responsive-375"
  "004 flight-consistency"
  "005 route-robustness"
  "006 map-toggle"
)

# Clean-run guards: no mutation flag is ever passed; make sure no LLM provider / custom memory leaks in.
unset QA_LLM_PROVIDER QA_LLM_MODEL QA_HEALING_MEMORY || true
mkdir -p "$SUB/videos" "$SUB/results" "$SUB/evidence" "$SUB/voiceover"

for entry in "${SCENARIOS[@]}"; do
  id="${entry%% *}"; name="${entry#* }"
  video="$SUB/videos/scenario-$id-$name.webm"
  if [[ -e "$video" && "${FORCE:-0}" != "1" ]]; then
    echo "refusing to overwrite $video (set FORCE=1 to re-capture)"; exit 1
  fi
  echo "=== capturing scenario-$id ($name)"
  ( cd "$QA" && npx tsx runner/run.ts --scenario "$id" ) > "$SUB/results/scenario-$id-terminal.log" 2>&1 || true
  src="$QA/evidence/scenario-$id"
  [[ -s "$src/recording.webm" ]] || { echo "no recording for scenario-$id"; exit 1; }
  chmod -R u+w "$SUB/evidence/scenario-$id" 2>/dev/null || true
  rm -rf "$SUB/evidence/scenario-$id"
  cp -r "$src" "$SUB/evidence/scenario-$id"
  chmod u+w "$video" 2>/dev/null || true
  cp "$src/recording.webm" "$video"
  cp "$src/result.json" "$SUB/results/scenario-$id-result.json"
  grep -E "^(PASS|DEFECT_FOUND|BLOCKED|HARNESS_ERROR) " "$SUB/results/scenario-$id-terminal.log" || true
done
echo "capture complete"
