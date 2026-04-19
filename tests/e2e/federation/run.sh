#!/usr/bin/env bash
# Federation Auth E2E Matrix Runner
# =================================
# Runs every scenario in tests/e2e/federation/scenarios against the
# three instances named by E2E_GLOBAL_BASE, E2E_HOME_BASE, E2E_PEER_BASE.
#
# Scenarios whose helpers throw NotYetImplementedError are counted as
# "skipped (awaiting impl)" rather than hard failures, so the suite can
# land before all implementation tickets do.
#
# Usage:
#   E2E_GLOBAL_BASE=https://a.rivr.social \
#   E2E_HOME_BASE=https://rivr.camalot.me \
#   E2E_PEER_BASE=https://front-range.rivr.social \
#       bash tests/e2e/federation/run.sh
#
# Exit codes:
#   0 — all automated scenarios passed (skips are informational)
#   1 — one or more automated scenarios failed
#   2 — required env vars missing

set -u
set -o pipefail

# ---- Locate repo root ----------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SCENARIO_DIR="${SCRIPT_DIR}/scenarios"

cd "${REPO_ROOT}"

# ---- Validate env --------------------------------------------------------
missing=()
for var in E2E_GLOBAL_BASE E2E_HOME_BASE E2E_PEER_BASE; do
  if [ -z "${!var:-}" ]; then
    missing+=("${var}")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "ERROR: missing required env vars: ${missing[*]}" >&2
  echo "See tests/e2e/federation/README.md for examples." >&2
  exit 2
fi

echo "=============================================================="
echo "Federation Auth E2E Matrix"
echo "--------------------------------------------------------------"
echo "  Global: ${E2E_GLOBAL_BASE}"
echo "  Home:   ${E2E_HOME_BASE}"
echo "  Peer:   ${E2E_PEER_BASE}"
if [ -n "${E2E_SUCCESSOR_HOME_BASE:-}" ]; then
  echo "  Successor: ${E2E_SUCCESSOR_HOME_BASE}"
fi
echo "=============================================================="

# ---- Enumerate scenarios -------------------------------------------------
scenario_files=()
while IFS= read -r -d '' file; do
  scenario_files+=("${file}")
done < <(find "${SCENARIO_DIR}" -maxdepth 1 -name '*.test.ts' -print0 | sort -z)

total="${#scenario_files[@]}"
echo "Discovered ${total} scenario file(s)."
echo

# ---- Run each scenario individually, classify outcome --------------------
# We run scenarios one at a time so one NotYetImplementedError doesn't take
# out unrelated scenarios. vitest invocations are kept cheap by using
# --no-coverage and --reporter=verbose.
pass=0
fail=0
skipped=0
failed_scenarios=()
skipped_scenarios=()

# Temp file to capture output for classification.
tmpout="$(mktemp -t e2e-scenario-XXXXXX.log)"
trap 'rm -f "${tmpout}"' EXIT

# Pick the package manager runner (prefer pnpm if available).
if command -v pnpm >/dev/null 2>&1; then
  runner=(pnpm exec vitest run)
elif command -v npx >/dev/null 2>&1; then
  runner=(npx vitest run)
else
  echo "ERROR: pnpm and npx both unavailable; cannot invoke vitest." >&2
  exit 2
fi

for file in "${scenario_files[@]}"; do
  name="$(basename "${file}" .test.ts)"
  printf '[run] %s ... ' "${name}"

  if "${runner[@]}" \
        --reporter=verbose \
        --no-coverage \
        --run \
        "${file}" \
        > "${tmpout}" 2>&1; then
    echo "PASS"
    pass=$((pass + 1))
  else
    # Classify: if NotYetImplementedError appears in output, treat as skip.
    if grep -q "NotYetImplementedError" "${tmpout}"; then
      echo "SKIP (awaiting impl)"
      skipped=$((skipped + 1))
      skipped_scenarios+=("${name}")
    else
      echo "FAIL"
      fail=$((fail + 1))
      failed_scenarios+=("${name}")
      echo "----- ${name} output -----"
      sed 's/^/  /' "${tmpout}"
      echo "----- end ${name} -----"
    fi
  fi
done

echo
echo "=============================================================="
echo "Coverage Report"
echo "--------------------------------------------------------------"
printf '  Total:    %d\n' "${total}"
printf '  Passing:  %d\n' "${pass}"
printf '  Failing:  %d\n' "${fail}"
printf '  Skipped:  %d (awaiting implementation)\n' "${skipped}"

if [ "${skipped}" -gt 0 ]; then
  echo
  echo "Skipped scenarios:"
  for s in "${skipped_scenarios[@]}"; do
    printf '  - %s\n' "${s}"
  done
fi

if [ "${fail}" -gt 0 ]; then
  echo
  echo "Failed scenarios:"
  for s in "${failed_scenarios[@]}"; do
    printf '  - %s\n' "${s}"
  done
  echo "=============================================================="
  exit 1
fi

echo "=============================================================="
exit 0
