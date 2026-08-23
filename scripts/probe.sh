#!/usr/bin/env bash
# Probe the newest machine in the catalogue (or the one named): the dynamic
# half of the gate. scripts/check.sh says the catalogue is well formed; this
# opens the machine in headless Chromium and makes sure it runs, alarms,
# resets, and opens its manual. Exit 0 when it does, or when there is nothing
# to probe yet.
#
#   scripts/probe.sh                      # the last entry in site/machines.json
#   scripts/probe.sh <slug>               # that one
#   scripts/probe.sh [<slug>] --out DIR   # screenshots somewhere else
set -euo pipefail
cd "$(dirname "$0")/.."

slug=""
rest=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) rest+=("$1" "${2:-}"); shift 2 ;;
    --*) rest+=("$1"); shift ;;
    *) if [ -z "$slug" ]; then slug="$1"; else rest+=("$1"); fi; shift ;;
  esac
done
if [ -z "$slug" ]; then
  slug="$(python3 -c 'import json; m=json.load(open("site/machines.json")); print(m[-1]["slug"] if m else "")' 2>/dev/null || true)"
fi
if [ -z "$slug" ]; then
  echo "probe: the catalogue is empty; nothing to probe"
  exit 0
fi
exec node scripts/probe.js "$slug" "${rest[@]}"
