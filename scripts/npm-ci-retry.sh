#!/bin/sh
# Retry complete installs after interrupted response bodies, which npm's
# request-level retries do not always recover, and after ETXTBSY from a
# postinstall script (esbuild's install.js executes the binary npm has just
# written; under BuildKit on overlayfs, with several images building at once,
# the file can still be open for writing — a clean second install succeeds).
# Keep the lockfile authoritative.
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
  # Do not retry lockfile, integrity, permission or other lifecycle-script failures.
  if [ "$attempt" -ge 3 ]; then exit "$status"; fi
  if grep -Eq '^npm (ERR!|error) code (ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)$' "$log"; then
    reason="npm network failure"
  elif grep -Eq "ETXTBSY" "$log"; then
    reason="a postinstall script hit ETXTBSY (binary still being written)"
  else
    exit "$status"
  fi
  echo "$reason; retrying install ($attempt/3) in $((attempt * 10)) seconds." >&2
  sleep "$((attempt * 10))"
  attempt=$((attempt + 1))
done
