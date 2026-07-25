#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: check-self-contained.sh <file.html>" >&2
  exit 2
fi

input_file="$1"
max_bytes="${AGENTPLAN_MAX_BYTES:-2097152}"

if [[ ! -f "$input_file" ]]; then
  echo "FAIL: file does not exist: $input_file" >&2
  exit 1
fi

case "$input_file" in
  *.html|*.htm) ;;
  *)
    echo "FAIL: expected a .html or .htm file." >&2
    exit 1
    ;;
esac

size_bytes="$(wc -c < "$input_file" | tr -d '[:space:]')"
if [[ "$size_bytes" -gt "$max_bytes" ]]; then
  echo "FAIL: $size_bytes bytes exceeds the AgentPlan HTML limit of $max_bytes bytes." >&2
  exit 1
fi

if grep -Eiq 'ap_live_[A-Za-z0-9_-]+' "$input_file"; then
  echo "FAIL: the HTML appears to contain an AgentPlan API token." >&2
  exit 1
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node "$script_directory/check-html-references.mjs" "$input_file"

if grep -Eq '__[A-Z][A-Z0-9_]+__' "$input_file"; then
  echo "FAIL: the HTML contains an unresolved template placeholder." >&2
  exit 1
fi

if ! grep -Eiq '<!doctype[[:space:]]+html' "$input_file"; then
  echo "FAIL: the HTML is missing <!doctype html>." >&2
  exit 1
fi

if ! grep -Eiq '<meta[^>]*[[:space:]]charset[[:space:]]*=' "$input_file"; then
  echo "FAIL: the HTML is missing a charset declaration." >&2
  exit 1
fi

echo "PASS: $input_file is self-contained and $size_bytes bytes."
