#!/bin/sh
# Retry complete installs after interrupted response bodies, which npm's
# request-level retries do not always recover. Keep the lockfile authoritative.
set -eu
log=$(mktemp)
trap 'rm -f "$log"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
attempt=1
while :; do
  if npm ci --no-audit --no-fund "$@" >"$log" 2>&1; then
    cat "$log"
    exit 0
  else
    status=$?
  fi
  cat "$log" >&2
  # Do not retry lockfile, integrity, permission or lifecycle-script failures.
  if [ "$attempt" -ge 3 ] || ! grep -Eq '^npm (ERR!|error) code (ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)$' "$log"; then
    exit "$status"
  fi
  echo "npm network failure; retrying install ($attempt/3) in $((attempt * 10)) seconds." >&2
  sleep "$((attempt * 10))"
  attempt=$((attempt + 1))
done
