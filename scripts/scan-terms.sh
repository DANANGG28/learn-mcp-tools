#!/usr/bin/env bash
# Repo cleanliness gate: fails when a tracked file contains or is named after
# either blocked term. The terms are assembled at runtime so this script itself
# never stores them literally.
set -euo pipefail
cd "$(dirname "$0")/.."

term_a=$(printf 'sle''arn')
term_b=$(printf 'j''ti')
fail=0

if git grep -nIi --text -e "$term_a" -e "$term_b" -- .; then
  echo "scan: blocked term found in file contents" >&2
  fail=1
fi

if git ls-files | grep -Iie "$term_a" -e "$term_b"; then
  echo "scan: blocked term found in file names" >&2
  fail=1
fi

[ "$fail" -eq 0 ] && echo "scan: bersih"
exit "$fail"
