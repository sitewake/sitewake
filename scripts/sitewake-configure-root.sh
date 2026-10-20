#!/usr/bin/env bash
set -euo pipefail

runtime_env=/etc/sitewake/runtime.env
incoming_root=/opt/sitewake-config-incoming
backup_root=/var/backups/sitewake
current_link=/opt/sitewake/current
lock_file=/run/lock/sitewake-production.lock

die() { echo "$*" >&2; exit 1; }
runtime_sha() { sha256sum "$runtime_env" | awk '{print $1}'; }
verify_runtime() {
  [ -f "$runtime_env" ] || die "missing production runtime configuration"
  [ "$(stat -c '%U:%G:%a' "$runtime_env")" = root:root:600 ] || die "runtime configuration must be root:root mode 600"
}
allowed_key() {
  case "$1" in
    MODEL|MODEL_API_KEY|MODEL_BASE_URL|MODEL_EXECUTION|MODEL_SEMANTIC|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|POSTGRES_POOL_SIZE|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|S3_BUCKET|SITEWAKE_MINIO_IMAGE|SITEWAKE_MC_IMAGE|SITEWAKE_IMAGE_REGISTRY|SITEWAKE_IMAGE_TAG|SITEWAKE_NPM_REGISTRY|SITEWAKE_BIND_ADDRESS|SITEWAKE_PORT|SITEWAKE_PUBLIC_ORIGIN|SITEWAKE_PUBLIC_HOSTNAME|SITEWAKE_DEMO_LOCK|SITEWAKE_PAGE_AGENT_RUNTIME_V2|SITEWAKE_PAGE_AGENT_EVIDENCE_V2|SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX|SITEWAKE_IDEMPOTENCY_SECRET|SITEWAKE_ANALYTICS_SALT|CAPABILITY_V2_BROWSER_PUBLIC_URL|CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN|CAPABILITY_V2_RUNNER_SECRET|CAPABILITY_V2_DISPATCH_TOKEN|CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN|CAPABILITY_V2_INPUT_KEY|CAPABILITY_V2_AUTO_DISPATCH|SITEWAKE_RUNNER_ENROLLMENT_TOKEN|SITEWAKE_LEGACY_RUNNER_PROTOCOL|SITEWAKE_RUNNER_LEASE_AUTHORITY|SITEWAKE_RUNNER_VISIBILITY|SITEWAKE_RUNNER_TOKEN|SITEWAKE_AUTHORING_RUNNER_ID|SITEWAKE_VALIDATION_RUNNER_ID|SITEWAKE_EXECUTION_RUNNER_ID|SITEWAKE_EXECUTION_RUNNER_CONCURRENCY|SITEWAKE_EXECUTION_RUNNER_PREWARM|SITEWAKE_CODEX_AUTHORING_TIMEOUT_MS|SITEWAKE_CODEX_AUTHORING_MAX_TOOL_CALLS|OPENAI_BASE_URL|OPENAI_API_KEY|OPENAI_MODEL|CLOUDFLARE_TUNNEL_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|CLOUDFLARE_D1_DATABASE_ID|CLOUDFLARE_ZONE_NAME|CLOUDFLARE_ROUTE_HOSTNAME|SITEWAKE_LAB_HOSTNAME|ACCESS_ADMIN_KEY) return 0;;
    *) return 1;;
  esac
}
validate_file() {
  local file=$1
  [ -f "$file" ] && [ ! -L "$file" ] || die "candidate must be a regular non-symlink file"
  declare -A seen=()
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" = \#* ]] && continue
    [[ "$line" =~ ^[A-Z][A-Z0-9_]*=.*$ ]] || die "malformed runtime configuration line"
    key=${line%%=*}
    allowed_key "$key" || die "runtime configuration key is not allowed: $key"
    [ -z "${seen[$key]+x}" ] || die "duplicate runtime configuration key: $key"
    seen[$key]=1
  done < "$file"
  [ "${#seen[@]}" -gt 0 ] || die "candidate configuration is empty"
}
compose() {
  local project_dir=$1
  shift
  SITEWAKE_RUNTIME_ENV_FILE="$runtime_env" docker compose --project-directory "$project_dir" \
    --env-file "$runtime_env" -f "$project_dir/compose.yaml" -f "$project_dir/compose.compact.yaml" "$@"
}

case "${1:-}" in
  status)
    [ "$#" -eq 1 ] || die "usage: status"
    [ "${SUDO_USER:-}" = sitewake-config ] || die "dedicated config identity required"
    verify_runtime
    printf '__SITEWAKE_RUNTIME_SHA256__=%s\n' "$(runtime_sha)"
    ;;
  prepare)
    [ "$#" -eq 3 ] || die "usage: prepare CHANGE_ID CONFIG_USER"
    [[ "$2" =~ ^[0-9a-f]{32}$ ]] || die "invalid change id"
    [[ "$3" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid config user"
    [ "$3" = sitewake-config ] && [ "${SUDO_USER:-}" = sitewake-config ] || die "dedicated config identity required"
    verify_runtime
    install -d -o "$3" -g "$3" -m 700 "$incoming_root/$2"
    ;;
  apply)
    [ "$#" -eq 4 ] || die "usage: apply CHANGE_ID EXPECTED_SHA CONFIRMATION"
    [ "$4" = sitewake-production ] || die "explicit production confirmation missing"
    [ "${SUDO_USER:-}" = sitewake-config ] || die "dedicated config identity required"
    [[ "$2" =~ ^[0-9a-f]{32}$ ]] || die "invalid change id"
    exec 9>"$lock_file"
    flock -x 9
    verify_runtime
    [ "$(runtime_sha)" = "$3" ] || die "production runtime configuration changed before update"
    patch="$incoming_root/$2/runtime.env"
    [ -f "$patch" ] && [ ! -L "$patch" ] || die "patch must be a regular non-symlink file"
    declare -A patch_seen=()
    while IFS= read -r line || [ -n "$line" ]; do
      [[ -z "$line" || "$line" = \#* ]] && continue
      if [[ "$line" =~ ^!([A-Z][A-Z0-9_]*)$ ]]; then key=${BASH_REMATCH[1]};
      elif [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=.*$ ]]; then key=${BASH_REMATCH[1]};
      else die "malformed runtime patch line"; fi
      allowed_key "$key" || die "runtime configuration key is not allowed: $key"
      [ -z "${patch_seen[$key]+x}" ] || die "duplicate runtime patch key: $key"
      patch_seen[$key]=1
    done < "$patch"
    [ "${#patch_seen[@]}" -gt 0 ] || die "runtime patch is empty"
    candidate="$incoming_root/$2/merged.env"
    changed_keys=$(python3 - "$runtime_env" "$patch" "$candidate" <<'PY'
import sys
def load(path):
    result={}
    for line in open(path, encoding="utf-8"):
        line=line.rstrip("\n")
        if line and not line.startswith("#"):
            key, value=line.split("=", 1)
            result[key]=value
    return result
before=load(sys.argv[1])
after=dict(before)
seen=set()
for number, raw in enumerate(open(sys.argv[2], encoding="utf-8"), 1):
    line=raw.rstrip("\n")
    if not line or line.startswith("#"): continue
    deleting=line.startswith("!")
    key=line[1:] if deleting else line.split("=", 1)[0]
    if not key or key in seen or (not deleting and "=" not in line):
        raise SystemExit(f"malformed or duplicate runtime patch line {number}")
    seen.add(key)
    if deleting: after.pop(key, None)
    else: after[key]=line.split("=", 1)[1]
changed=sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
with open(sys.argv[3], "w", encoding="utf-8", newline="\n") as output:
    for key in sorted(after): output.write(f"{key}={after[key]}\n")
print("\n".join(changed))
PY
)
    validate_file "$candidate"
    services=()
    need_validation=0
    need_execution=0
    need_edge=0
    running_services=$(compose "$(readlink -f "$current_link")" --profile validation --profile execution --profile edge ps --services --status running)
    while IFS= read -r key; do
      case "$key" in
        POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB) services+=(postgres control-plane);;
        POSTGRES_POOL_SIZE) services+=(control-plane);;
        MINIO_*|S3_BUCKET) services+=(minio minio-init control-plane);;
        SITEWAKE_MINIO_IMAGE) services+=(minio);;
        SITEWAKE_IMAGE_REGISTRY|SITEWAKE_IMAGE_TAG) services+=(control-plane capability-v2-runtime-launcher authoring-worker); grep -qx validation-worker <<<"$running_services" && { services+=(validation-worker); need_validation=1; }; grep -qx execution-worker <<<"$running_services" && { services+=(execution-worker); need_execution=1; };;
        SITEWAKE_MC_IMAGE) services+=(minio-init);;
        CLOUDFLARE_TUNNEL_TOKEN) grep -qx cloudflared <<<"$running_services" && { services+=(cloudflared); need_edge=1; };;
        SITEWAKE_VALIDATION_RUNNER_ID) grep -qx validation-worker <<<"$running_services" && { services+=(validation-worker); need_validation=1; };;
        SITEWAKE_EXECUTION_RUNNER_ID|SITEWAKE_EXECUTION_RUNNER_CONCURRENCY|SITEWAKE_EXECUTION_RUNNER_PREWARM) grep -qx execution-worker <<<"$running_services" && { services+=(execution-worker); need_execution=1; };;
        # Model keys reach only the control plane; workers use its internal proxy.
        MODEL|MODEL_*|OPENAI_*) services+=(control-plane);;
        SITEWAKE_PUBLIC_ORIGIN|CAPABILITY_V2_DISPATCH_TOKEN) services+=(control-plane capability-v2-runtime-launcher authoring-worker); grep -qx validation-worker <<<"$running_services" && { services+=(validation-worker); need_validation=1; }; grep -qx execution-worker <<<"$running_services" && { services+=(execution-worker); need_execution=1; };;
        CAPABILITY_V2_BROWSER_PUBLIC_URL) services+=(control-plane capability-v2-runtime-launcher);;
        CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN|SITEWAKE_DEMO_LOCK) services+=(control-plane);;
        CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN) services+=(control-plane capability-v2-runtime-launcher);;
        SITEWAKE_RUNNER_ENROLLMENT_TOKEN|SITEWAKE_LEGACY_RUNNER_PROTOCOL) services+=(control-plane authoring-worker); grep -qx validation-worker <<<"$running_services" && { services+=(validation-worker); need_validation=1; }; grep -qx execution-worker <<<"$running_services" && { services+=(execution-worker); need_execution=1; };;
        SITEWAKE_AUTHORING_RUNNER_ID|SITEWAKE_CODEX_AUTHORING_*|SITEWAKE_RUNNER_*) services+=(control-plane authoring-worker);;
        CAPABILITY_V2_RUNNER_SECRET) services+=(control-plane);;
        *) services+=(control-plane);;
      esac
    done <<<"$changed_keys"
    mapfile -t services < <(printf '%s\n' "${services[@]}" | sort -u)
    profiles=()
    [ "$need_validation" -eq 1 ] && profiles+=(--profile validation)
    [ "$need_execution" -eq 1 ] && profiles+=(--profile execution)
    [ "$need_edge" -eq 1 ] && profiles+=(--profile edge)
    [ "${#services[@]}" -gt 0 ] || { echo "Patch does not change production configuration."; rm -rf -- "$incoming_root/$2"; exit 0; }
    release=$(readlink -f "$current_link")
    [ -d "$release" ] || die "active release missing"
    container_id=$(compose "$release" ps --all --quiet control-plane | head -n 1)
    [ -n "$container_id" ] || die "active control-plane container unavailable"
    build_sha=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^SITEWAKE_BUILD_SHA=//p' | head -n 1)
    [[ "$build_sha" =~ ^[0-9a-f]{40}$ ]] || die "active release build SHA unavailable"
    export SITEWAKE_BUILD_SHA="$build_sha"
    install -d -o root -g root -m 700 "$backup_root"
    backup="$backup_root/runtime.env.$(date -u +%Y%m%d-%H%M%S).$2"
    cp -p "$runtime_env" "$backup"
    configuration_replaced=0
    rollback() {
      status=$?
      trap - EXIT
      rollback_status=0
      if [ "$status" -ne 0 ] && [ "$configuration_replaced" -eq 1 ]; then
        rollback_temporary="$(dirname "$runtime_env")/.runtime.env.rollback.$2"
        install -o root -g root -m 600 "$backup" "$rollback_temporary" || rollback_status=1
        if [ "$rollback_status" -eq 0 ]; then sync -f "$rollback_temporary" || rollback_status=1; fi
        if [ "$rollback_status" -eq 0 ]; then mv -f "$rollback_temporary" "$runtime_env" || rollback_status=1; fi
        sync -f "$(dirname "$runtime_env")" || rollback_status=1
        compose "$release" "${profiles[@]}" up -d --no-build --force-recreate "${services[@]}" || rollback_status=1
        restored=0
        for attempt in $(seq 1 24); do
          response=$(curl --fail --silent --show-error --max-time 8 http://127.0.0.1:3000/api/health || true)
          if grep -Fq '"status":"ready"' <<<"$response" && grep -Fq '"runtime":"container"' <<<"$response" && grep -Fq "\"buildSha\":\"$build_sha\"" <<<"$response"; then restored=1; break; fi
          sleep 5
        done
        [ "$restored" -eq 1 ] || rollback_status=1
      fi
      if [ "$rollback_status" -ne 0 ]; then
        echo "FATAL: configuration rollback failed health verification" >&2
        exit 125
      fi
      exit "$status"
    }
    trap rollback EXIT
    echo "Production configuration diff (values redacted):"
    python3 - "$runtime_env" "$candidate" <<'PY'
import sys
def values(path):
    return dict(line.rstrip("\n").split("=", 1) for line in open(path, encoding="utf-8") if line.strip() and not line.startswith("#"))
before=values(sys.argv[1]); after=values(sys.argv[2])
for key in sorted(before | after):
    if before.get(key) == after.get(key): continue
    marker="+" if key not in before else "-" if key not in after else "~"
    print(f"{marker} {key}=<redacted>")
PY
    temporary="$(dirname "$runtime_env")/.runtime.env.$2"
    install -o root -g root -m 600 "$candidate" "$temporary"
    sync -f "$temporary"
    configuration_replaced=1
    mv -f "$temporary" "$runtime_env"
    sync -f "$(dirname "$runtime_env")"
    compose "$release" "${profiles[@]}" up -d --no-build --force-recreate "${services[@]}"
    for attempt in $(seq 1 24); do
      response=$(curl --fail --silent --show-error --max-time 8 http://127.0.0.1:3000/api/health || true)
      if grep -Fq '"status":"ready"' <<<"$response" && grep -Fq '"runtime":"container"' <<<"$response"; then break; fi
      [ "$attempt" -lt 24 ] || die "configuration health check failed"
      sleep 5
    done
    verify_runtime
    rm -rf -- "$incoming_root/$2"
    trap - EXIT
    ;;
  *) die "unknown command";;
esac
