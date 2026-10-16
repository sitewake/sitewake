#!/usr/bin/env bash
set -euo pipefail

runtime_env=/etc/sitewake/runtime.env
incoming_root=/opt/sitewake-incoming
releases_root=/opt/sitewake-releases
current_link=/opt/sitewake/current
lock_file=/run/lock/sitewake-production.lock

die() { echo "$*" >&2; exit 1; }
valid_id() { [[ "$1" =~ ^[0-9a-f]{40}(-[0-9]+)?$ ]]; }
runtime_sha() { sha256sum "$runtime_env" | awk '{print $1}'; }
verify_runtime() {
  [ -f "$runtime_env" ] || die "missing production runtime configuration: $runtime_env"
  [ "$(stat -c '%U:%G:%a' "$runtime_env")" = root:root:600 ] || die "runtime configuration must be root:root mode 600"
}
verify_expected_sha() {
  verify_runtime
  [ "$(runtime_sha)" = "$1" ] || die "production runtime configuration changed during release"
}
compose() {
  local project_dir=$1
  shift
  SITEWAKE_RUNTIME_ENV_FILE="$runtime_env" docker compose \
    --project-directory "$project_dir" \
    --env-file "$runtime_env" \
    -f "$project_dir/compose.yaml" -f "$project_dir/compose.compact.yaml" "$@"
}
validate_compose_policy() {
  local project_dir=$1
  if grep -REq "^[[:space:]]*[\"']?env_file[\"']?[[:space:]]*:" "$project_dir/compose.yaml" "$project_dir/compose.compact.yaml"; then
    die "compose env_file is forbidden; expose only explicit environment keys"
  fi
  SITEWAKE_RUNTIME_ENV_FILE="$runtime_env" docker compose \
    --project-directory "$project_dir" --env-file "$runtime_env" \
    --profile validation --profile execution --profile edge \
    -f "$project_dir/compose.yaml" -f "$project_dir/compose.compact.yaml" config --format json \
    | python3 -c '
import json, os, re, sys
config=json.load(sys.stdin)
root=os.path.realpath(sys.argv[1]) if len(sys.argv)>1 else None
allowed_services={"control-plane","capability-v2-runtime-launcher","postgres","minio","minio-init","authoring-worker","validation-worker","execution-worker","cloudflared"}
if set(config.get("services",{})) != allowed_services:
  raise SystemExit("compose service set differs from the root-approved topology")
allowed_environment={
 "control-plane": {"ACCESS_ADMIN_KEY","CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN","CAPABILITY_V2_AUTO_DISPATCH","CAPABILITY_V2_BROWSER_PUBLIC_URL","CAPABILITY_V2_CONTROL_PLANE_URL","CAPABILITY_V2_DISPATCH_TOKEN","CAPABILITY_V2_INPUT_KEY","CAPABILITY_V2_RUNNER_SECRET","CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN","CAPABILITY_V2_RUNTIME_LAUNCHER_URL","DATABASE_URL","SITEWAKE_LEGACY_RUNNER_PROTOCOL","SITEWAKE_RUNNER_ENROLLMENT_TOKEN","SITEWAKE_RUNNER_LEASE_AUTHORITY","SITEWAKE_RUNNER_TOKEN","SITEWAKE_RUNNER_VISIBILITY","MODEL","MODEL_API_KEY","MODEL_BASE_URL","MODEL_EXECUTION","MODEL_SEMANTIC","NODE_OPTIONS","OPENAI_API_KEY","OPENAI_BASE_URL","OPENAI_MODEL","POSTGRES_POOL_SIZE","S3_ACCESS_KEY_ID","S3_BUCKET","S3_ENDPOINT","S3_FORCE_PATH_STYLE","S3_REGION","S3_SECRET_ACCESS_KEY","SITEWAKE_ANALYTICS_SALT","SITEWAKE_BUILD_SHA","SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX","SITEWAKE_CONTENT_FILTER","SITEWAKE_IDEMPOTENCY_SECRET","SITEWAKE_MAINTENANCE_TOKEN","SITEWAKE_PAGE_AGENT_EVIDENCE_V2","SITEWAKE_PAGE_AGENT_RUNTIME_V2","SITEWAKE_PUBLIC_ORIGIN","VINEXT_TRUSTED_HOSTS"},
 "capability-v2-runtime-launcher": {"SITEWAKE_MODEL_PROXY_URL","CAPABILITY_V2_ARTIFACT_DIR","CAPABILITY_V2_BROWSER_PUBLIC_URL","CAPABILITY_V2_CONTROL_PLANE_URL","CAPABILITY_V2_DISPATCH_INTERVAL_MS","CAPABILITY_V2_DISPATCH_TOKEN","CAPABILITY_V2_RUNTIME_CONCURRENCY","CAPABILITY_V2_RUNTIME_LAUNCHER_HOST","CAPABILITY_V2_RUNTIME_LAUNCHER_PORT","CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN","NODE_OPTIONS"},
 "postgres": {"POSTGRES_DB","POSTGRES_PASSWORD","POSTGRES_USER"},
 "minio": {"MINIO_ROOT_PASSWORD","MINIO_ROOT_USER"},
 "minio-init": {"MINIO_ROOT_PASSWORD","MINIO_ROOT_USER","S3_BUCKET"},
 "authoring-worker": {"CAPABILITY_V2_DISPATCH_TOKEN","SITEWAKE_AUTHORING_WORKSPACE_ROOT","SITEWAKE_BROWSER_PUBLIC_URL","SITEWAKE_CODEX_AUTHORING_MAX_TOOL_CALLS","SITEWAKE_CODEX_AUTHORING_TIMEOUT_MS","SITEWAKE_CONTROL_PLANE_URL","SITEWAKE_LEGACY_RUNNER_PROTOCOL","SITEWAKE_RUNNER_CONCURRENCY","SITEWAKE_RUNNER_ENROLLMENT_TOKEN","SITEWAKE_RUNNER_ID","SITEWAKE_RUNNER_NAME","SITEWAKE_RUNNER_PREWARM","SITEWAKE_RUNNER_ROLE","SITEWAKE_MODEL_PROXY_URL","SITEWAKE_LAYER_TEMPLATE","SITEWAKE_LAYER_TIME"},
 "validation-worker": {"SITEWAKE_MODEL_PROXY_URL","CAPABILITY_V2_DISPATCH_TOKEN","SITEWAKE_BROWSER_PUBLIC_URL","SITEWAKE_CONTROL_PLANE_URL","SITEWAKE_LEGACY_RUNNER_PROTOCOL","SITEWAKE_RUNNER_CONCURRENCY","SITEWAKE_RUNNER_ENROLLMENT_TOKEN","SITEWAKE_RUNNER_ID","SITEWAKE_RUNNER_NAME","SITEWAKE_RUNNER_PREWARM","SITEWAKE_RUNNER_ROLE"},
 "execution-worker": {"SITEWAKE_MODEL_PROXY_URL","CAPABILITY_V2_DISPATCH_TOKEN","SITEWAKE_BROWSER_PUBLIC_URL","SITEWAKE_CONTROL_PLANE_URL","SITEWAKE_LEGACY_RUNNER_PROTOCOL","SITEWAKE_RUNNER_CONCURRENCY","SITEWAKE_RUNNER_ENROLLMENT_TOKEN","SITEWAKE_RUNNER_ID","SITEWAKE_RUNNER_NAME","SITEWAKE_RUNNER_PREWARM","SITEWAKE_RUNNER_ROLE"},
 "cloudflared": {"TUNNEL_TOKEN"},
}
def inside(path):
  resolved=os.path.realpath(path)
  return resolved == root or resolved.startswith(root + os.sep)
for kind in ("secrets", "configs"):
  if config.get(kind): raise SystemExit(f"top-level compose {kind} are forbidden")
networks=config.get("networks",{})
if set(networks) != {"default"}:
  raise SystemExit("compose network set differs from the root-approved topology")
default_network=networks.get("default") or {}
allowed_network_keys={"name","ipam","driver","driver_opts","external","internal","attachable","enable_ipv4","enable_ipv6","labels"}
if (set(default_network) - allowed_network_keys
    or default_network.get("name") not in (None, "sitewake_default")
    or default_network.get("driver") not in (None, "bridge")
    or default_network.get("driver_opts") not in (None, {})
    or default_network.get("ipam") not in (None, {})
    or default_network.get("external") not in (None, False)
    or default_network.get("internal") not in (None, False)
    or default_network.get("attachable") not in (None, False)
    or default_network.get("enable_ipv4") not in (None, True)
    or default_network.get("enable_ipv6") not in (None, False)
    or default_network.get("labels") not in (None, {})):
  raise SystemExit("compose default network contract changed")
allowed_volumes={"postgres-data","minio-data","authoring-workspaces"}
if set(config.get("volumes",{})) != allowed_volumes:
  raise SystemExit("compose volume set differs from the root-approved topology")
for name, volume in config.get("volumes", {}).items():
  if isinstance(volume, dict) and (volume.get("driver_opts") or volume.get("external") or volume.get("name") not in (None, f"sitewake_{name}")):
    raise SystemExit(f"volume driver options are forbidden: {name}")
expected_images={"postgres":"postgres:16-alpine","minio":"docker.io/pgsty/minio:RELEASE.2026-08-04T00-00-00Z","minio-init":"docker.io/pgsty/mc:RELEASE.2026-09-16T00-00-00Z","cloudflared":"cloudflare/cloudflared:latest"}
expected_dockerfiles={"control-plane":"Dockerfile","capability-v2-runtime-launcher":"Dockerfile.capability-v2-runner","authoring-worker":"Dockerfile.worker","validation-worker":"Dockerfile.worker","execution-worker":"Dockerfile.worker"}
expected_commands={
 "control-plane": None,
 "capability-v2-runtime-launcher": ["node","scripts/capability-v2-runtime-launcher.mjs"],
 "postgres": ["postgres","-c","shared_buffers=64MB","-c","work_mem=2MB","-c","max_connections=20"],
 "minio": ["server","/data","--console-address",":9001"],
 "minio-init": ["mc alias set local http://minio:9000 $$MINIO_ROOT_USER $$MINIO_ROOT_PASSWORD && mc mb --ignore-existing local/$$S3_BUCKET"],
 "authoring-worker": None,"validation-worker": None,"execution-worker": None,
 "cloudflared": ["tunnel","--no-autoupdate","run"],
}
expected_volumes={
 "authoring-worker": [("authoring-workspaces","/workspaces")],
 "postgres": [("postgres-data","/var/lib/postgresql/data")],
 "minio": [("minio-data","/data")],
}
for name, service in config.get("services", {}).items():
  allowed_service_keys={"build","command","depends_on","entrypoint","environment","healthcheck","image","mem_limit","networks","ports","profiles","restart","volumes"}
  unknown_service_keys=set(service) - allowed_service_keys
  if unknown_service_keys:
    raise SystemExit(f"unapproved compose service fields for {name}: {sorted(unknown_service_keys)}")
  expected_entrypoint=["/bin/sh","-c"] if name == "minio-init" else None
  if service.get("entrypoint") != expected_entrypoint:
    raise SystemExit(f"compose entrypoint changed for {name}")
  if service.get("networks") != {"default": None}:
    raise SystemExit(f"compose network attachment changed for {name}")
  if service.get("env_file"): raise SystemExit(f"compose env_file is forbidden in {name}")
  if set(service.get("environment",{})) != allowed_environment[name]:
    raise SystemExit(f"compose environment contract changed for {name}")
  if service.get("command") != expected_commands[name]: raise SystemExit(f"compose command changed for {name}")
  if name in expected_images and service.get("image") != expected_images[name]:
    raise SystemExit(f"compose image changed for {name}")
  if name not in expected_images and service.get("image"):
    # Self-built services name the prebuilt image ./setup pulls; production
    # builds from source (--build) and merely tags the result with that name.
    if not re.fullmatch(r"ghcr\.io/sitewake/sitewake-(control-plane|launcher|worker):[A-Za-z0-9._-]+", service["image"]):
      raise SystemExit(f"unexpected external image for {name}")
  ports=service.get("ports",[])
  if name != "control-plane" and ports: raise SystemExit(f"unexpected published ports for {name}")
  if name == "control-plane":
    if len(ports) != 1: raise SystemExit("control-plane must expose exactly one port")
    port=ports[0]
    if port.get("target") != 3000 or str(port.get("published")) != "3000" or port.get("protocol") != "tcp" or port.get("host_ip") not in {"127.0.0.1","0.0.0.0"}:
      raise SystemExit("control-plane published port contract changed")
  if service.get("privileged") or service.get("cap_add") or service.get("devices"):
    raise SystemExit(f"unsafe compose privilege in {name}")
  if service.get("pid") == "host" or service.get("ipc") == "host" or service.get("network_mode") == "host":
    raise SystemExit(f"unsafe host namespace in {name}")
  if service.get("volumes_from") or service.get("secrets") or service.get("configs"):
    raise SystemExit(f"unreviewed compose indirection in {name}")
  build=service.get("build")
  if build:
    build={"context": build} if isinstance(build, str) else build
    context=build.get("context", root)
    context=context if os.path.isabs(context) else os.path.join(root, context)
    if not inside(context): raise SystemExit(f"build context escapes release: {name}")
    dockerfile=build.get("dockerfile", "Dockerfile")
    dockerfile=dockerfile if os.path.isabs(dockerfile) else os.path.join(context, dockerfile)
    if not inside(dockerfile): raise SystemExit(f"dockerfile escapes release: {name}")
    if build.get("additional_contexts"): raise SystemExit(f"additional build contexts are forbidden: {name}")
    if set(build) - {"context","dockerfile","args"}: raise SystemExit(f"unapproved build option in {name}")
    if set(build.get("args",{})) - {"SITEWAKE_BUILD_SHA","SITEWAKE_NPM_REGISTRY"}: raise SystemExit(f"unapproved build argument in {name}")
    if os.path.basename(dockerfile) != expected_dockerfiles.get(name): raise SystemExit(f"unapproved dockerfile for {name}")
  elif name in expected_dockerfiles: raise SystemExit(f"missing approved build for {name}")
  normalized_volumes=[]
  for volume in service.get("volumes", []):
    if isinstance(volume, dict) and volume.get("type") == "bind":
      raise SystemExit(f"host bind mounts are forbidden in {name}")
    if "/etc/sitewake" in str(volume) or "/var/run/docker.sock" in str(volume):
      raise SystemExit(f"protected host path in {name}")
    if not isinstance(volume, dict) or volume.get("type") != "volume" or set(volume) - {"type","source","target","volume","read_only","bind","consistency"}:
      raise SystemExit(f"unapproved volume mount in {name}")
    normalized_volumes.append((volume.get("source"),volume.get("target")))
  if normalized_volumes != expected_volumes.get(name,[]):
    raise SystemExit(f"compose volume mounts changed for {name}")
' "$project_dir"
  (
    raw_dir=$(mktemp -d)
    trap 'rm -rf -- "$raw_dir"' EXIT
    sed -e 's/${SITEWAKE_BIND_ADDRESS:-0.0.0.0}/0.0.0.0/g' -e 's/${SITEWAKE_PORT:-3000}/3000/g' "$project_dir/compose.yaml" > "$raw_dir/compose.yaml"
    sed -e 's/${SITEWAKE_BIND_ADDRESS:-0.0.0.0}/0.0.0.0/g' -e 's/${SITEWAKE_PORT:-3000}/3000/g' "$project_dir/compose.compact.yaml" > "$raw_dir/compose.compact.yaml"
    SITEWAKE_RUNTIME_ENV_FILE="$runtime_env" docker compose \
      --project-directory "$project_dir" --env-file "$runtime_env" \
      --profile validation --profile execution --profile edge \
      -f "$raw_dir/compose.yaml" -f "$raw_dir/compose.compact.yaml" config --no-interpolate --format json \
      | python3 -c '
import json,re,sys
config=json.load(sys.stdin)
cross={
 ("control-plane","DATABASE_URL"): {"POSTGRES_USER","POSTGRES_PASSWORD","POSTGRES_DB"},
 ("control-plane","S3_ACCESS_KEY_ID"): {"MINIO_ROOT_USER"},
 ("control-plane","S3_SECRET_ACCESS_KEY"): {"MINIO_ROOT_PASSWORD"},
 ("control-plane","CAPABILITY_V2_BROWSER_PUBLIC_URL"): {"CAPABILITY_V2_BROWSER_PUBLIC_URL","SITEWAKE_PUBLIC_ORIGIN"},
 ("control-plane","VINEXT_TRUSTED_HOSTS"): {"SITEWAKE_PUBLIC_HOSTNAME"},
 ("capability-v2-runtime-launcher","CAPABILITY_V2_BROWSER_PUBLIC_URL"): {"CAPABILITY_V2_BROWSER_PUBLIC_URL","SITEWAKE_PUBLIC_ORIGIN"},
 ("authoring-worker","SITEWAKE_BROWSER_PUBLIC_URL"): {"SITEWAKE_PUBLIC_ORIGIN"},
 ("authoring-worker","SITEWAKE_RUNNER_ID"): {"SITEWAKE_AUTHORING_RUNNER_ID"},
 ("validation-worker","SITEWAKE_BROWSER_PUBLIC_URL"): {"SITEWAKE_PUBLIC_ORIGIN"},
 ("validation-worker","SITEWAKE_RUNNER_ID"): {"SITEWAKE_VALIDATION_RUNNER_ID"},
 ("execution-worker","SITEWAKE_BROWSER_PUBLIC_URL"): {"SITEWAKE_PUBLIC_ORIGIN"},
 ("execution-worker","SITEWAKE_RUNNER_ID"): {"SITEWAKE_EXECUTION_RUNNER_ID"},
 ("execution-worker","SITEWAKE_RUNNER_CONCURRENCY"): {"SITEWAKE_EXECUTION_RUNNER_CONCURRENCY"},
 ("execution-worker","SITEWAKE_RUNNER_PREWARM"): {"SITEWAKE_EXECUTION_RUNNER_PREWARM"},
 ("cloudflared","TUNNEL_TOKEN"): {"CLOUDFLARE_TUNNEL_TOKEN"},
}
literal={
 ("control-plane","CAPABILITY_V2_CONTROL_PLANE_URL"): "http://control-plane:3000",
 ("control-plane","CAPABILITY_V2_RUNTIME_LAUNCHER_URL"): "http://capability-v2-runtime-launcher:3320",
 ("control-plane","POSTGRES_POOL_SIZE"): "3",
 ("control-plane","S3_ENDPOINT"): "http://minio:9000",
 ("control-plane","S3_FORCE_PATH_STYLE"): "true",
 ("control-plane","S3_REGION"): "us-east-1",
 ("control-plane","NODE_OPTIONS"): "--max-old-space-size=384",
 ("capability-v2-runtime-launcher","CAPABILITY_V2_ARTIFACT_DIR"): "/tmp/capability-v2-artifacts",
 ("capability-v2-runtime-launcher","CAPABILITY_V2_CONTROL_PLANE_URL"): "http://control-plane:3000",
 ("capability-v2-runtime-launcher","CAPABILITY_V2_DISPATCH_INTERVAL_MS"): "5000",
 ("capability-v2-runtime-launcher","CAPABILITY_V2_RUNTIME_CONCURRENCY"): "1",
 ("capability-v2-runtime-launcher","CAPABILITY_V2_RUNTIME_LAUNCHER_HOST"): "0.0.0.0",
 ("capability-v2-runtime-launcher","CAPABILITY_V2_RUNTIME_LAUNCHER_PORT"): "3320",
 ("capability-v2-runtime-launcher","NODE_OPTIONS"): "--max-old-space-size=384",
 ("capability-v2-runtime-launcher","SITEWAKE_MODEL_PROXY_URL"): "http://control-plane:3000/api/internal/model",
 ("authoring-worker","SITEWAKE_MODEL_PROXY_URL"): "http://control-plane:3000/api/internal/model",
 ("validation-worker","SITEWAKE_MODEL_PROXY_URL"): "http://control-plane:3000/api/internal/model",
 ("execution-worker","SITEWAKE_MODEL_PROXY_URL"): "http://control-plane:3000/api/internal/model",
 ("authoring-worker","SITEWAKE_AUTHORING_WORKSPACE_ROOT"): "/workspaces",
 ("authoring-worker","SITEWAKE_CONTROL_PLANE_URL"): "http://control-plane:3000",
 ("authoring-worker","SITEWAKE_RUNNER_CONCURRENCY"): "1",
 ("authoring-worker","SITEWAKE_RUNNER_NAME"): "Program Author Agent",
 ("authoring-worker","SITEWAKE_RUNNER_PREWARM"): "0",
 ("authoring-worker","SITEWAKE_RUNNER_ROLE"): "any",
 ("validation-worker","SITEWAKE_CONTROL_PLANE_URL"): "http://control-plane:3000",
 ("validation-worker","SITEWAKE_RUNNER_CONCURRENCY"): "1",
 ("validation-worker","SITEWAKE_RUNNER_NAME"): "Independent Validation",
 ("validation-worker","SITEWAKE_RUNNER_PREWARM"): "0",
 ("validation-worker","SITEWAKE_RUNNER_ROLE"): "validate",
 ("execution-worker","SITEWAKE_CONTROL_PLANE_URL"): "http://control-plane:3000",
 ("execution-worker","SITEWAKE_RUNNER_NAME"): "Capability Execution",
 ("execution-worker","SITEWAKE_RUNNER_ROLE"): "interactive",
}
for service_name,service in config.get("services",{}).items():
  environment=service.get("environment",[])
  assignments=[f"{key}={value}" for key,value in environment.items()] if isinstance(environment,dict) else environment
  for assignment in assignments:
    key,value=assignment.split("=",1)
    refs=set(re.findall(r"\$\{([A-Z][A-Z0-9_]*)",value))
    allowed=cross.get((service_name,key),{key})
    if not refs <= allowed:
      raise SystemExit(f"environment source is not approved for {service_name}.{key}")
    if not refs and literal.get((service_name,key)) != value:
      raise SystemExit(f"environment literal is not approved for {service_name}.{key}")
'
  )
}
atomic_current() {
  local target=$1
  local temporary="$current_link.next.$release_id"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$current_link"
}

case "${1:-}" in
  config-sha)
    [ "$#" -eq 1 ] || die "usage: config-sha"
    [ "${SUDO_USER:-}" = sitewake-deploy ] || die "dedicated deploy identity required"
    verify_runtime
    runtime_sha
    ;;
  prepare-release)
    [ "$#" -eq 3 ] || die "usage: prepare-release RELEASE_ID DEPLOY_USER"
    valid_id "$2" || die "invalid release id"
    [[ "$3" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid deploy user"
    [ "$3" = sitewake-deploy ] && [ "${SUDO_USER:-}" = sitewake-deploy ] || die "dedicated deploy identity required"
    verify_runtime
    install -d -o "$3" -g "$3" -m 700 "$incoming_root/$2"
    ;;
  activate-release)
    [ "$#" -eq 4 ] || die "usage: activate-release RELEASE_ID CONFIG_SHA BUILD_SHA"
    release_id=$2
    expected_sha=$3
    build_sha=$4
    [ "${SUDO_USER:-}" = sitewake-deploy ] || die "dedicated deploy identity required"
    valid_id "$release_id" || die "invalid release id"
    [[ "$build_sha" =~ ^[0-9a-f]{40}$ ]] || die "invalid build sha"
    verify_expected_sha "$expected_sha"
    exec 9>"$lock_file"
    flock -x 9
    verify_expected_sha "$expected_sha"
    incoming="$incoming_root/$release_id"
    release="$releases_root/$release_id"
    [ -d "$incoming" ] || die "release staging directory missing"
    [ -f "$incoming/compose.yaml" ] && [ -f "$incoming/compose.compact.yaml" ] || die "release compose files missing"
    if find "$incoming" ! -type d ! -type f | grep -q . \
      || find "$incoming" -type f \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '*.kdbx' -o -name 'id_rsa' -o -name 'id_ed25519' -o -name '.npmrc' -o -name '.pypirc' -o -name '.netrc' -o -name '.dockercfg' -o -name '.git-credentials' -o -name 'auth.json' -o -name 'token.txt' -o -name 'application_default_credentials.json' -o -name 'service-account*.json' \) | grep -q . \
      || find "$incoming" -type f | grep -Ei '(^|/)(credentials?|secrets?)(/|\.|$)|/\.docker/config\.json$|/\.aws/credentials$' >/dev/null; then
      die "release contains symlinks, environment files, private keys, or credentials"
    fi
    install -d -o root -g root -m 755 "$releases_root"
    [ ! -e "$release" ] || die "release already exists"
    source_manifest=$(mktemp)
    release_manifest=$(mktemp)
    (cd "$incoming" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$source_manifest"
    chown -R root:root "$incoming"
    find "$incoming" -type d -exec chmod 500 {} +
    find "$incoming" -type f -exec chmod 400 {} +
    sync
    install -d -o root -g root -m 755 "$release"
    cp -a --reflink=never --no-preserve=ownership "$incoming/." "$release/"
    chown -R root:root "$release"
    chmod -R go-w "$release"
    (cd "$release" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$release_manifest"
    cmp -s "$source_manifest" "$release_manifest" || die "release snapshot changed while copying"
    find "$release" ! -type d ! -type f | grep -q . && die "release snapshot contains unsupported file types"
    rm -f "$source_manifest" "$release_manifest"
    rm -rf -- "$incoming"
    validate_compose_policy "$release"
    # `readlink -e` (not -f): a missing or dangling `current` yields "" so the
    # first release on a host has no previous to inspect or roll back to.
    previous=$(readlink -e "$current_link" 2>/dev/null || true)
    running_services=""
    previous_build_sha=development
    if [ -n "$previous" ] && [ -d "$previous" ]; then
      running_services=$(compose "$previous" --profile validation --profile execution --profile edge ps --services --status running)
      previous_container=$(compose "$previous" ps --all --quiet control-plane | head -n 1)
      if [ -n "$previous_container" ]; then
        previous_build_sha=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$previous_container" | sed -n 's/^SITEWAKE_BUILD_SHA=//p' | head -n 1)
        previous_build_sha=${previous_build_sha:-development}
      fi
    fi
    code_optional_services=()
    runtime_optional_services=()
    profiles=()
    grep -qx validation-worker <<<"$running_services" && { code_optional_services+=(validation-worker); runtime_optional_services+=(validation-worker); profiles+=(--profile validation); }
    grep -qx execution-worker <<<"$running_services" && { code_optional_services+=(execution-worker); runtime_optional_services+=(execution-worker); profiles+=(--profile execution); }
    grep -qx cloudflared <<<"$running_services" && { runtime_optional_services+=(cloudflared); profiles+=(--profile edge); }
    application_services=(control-plane capability-v2-runtime-launcher authoring-worker "${runtime_optional_services[@]}")
    # This host is a disposable product-validation server. The owner explicitly
    # opted out of database backups; rollback restores application images only.
    echo "Test-server release: database backup disabled; checking build capacity."
    available_bytes=$(df -PB1 /var/lib/containerd | awk 'NR == 2 { print $4 }')
    minimum_release_bytes=$((4 * 1024 * 1024 * 1024))
    [ "${available_bytes:-0}" -ge "$minimum_release_bytes" ] || die "insufficient disk space for immutable release"
    declare -A previous_image_ids=()
    declare -A previous_image_refs=()
    rollback_tags=()
    for service in "${application_services[@]}"; do
      [ -n "$previous" ] && [ -d "$previous" ] || continue
      container_id=$(compose "$previous" "${profiles[@]}" ps --all --quiet "$service" | head -n 1)
      [ -n "$container_id" ] || continue
      image_id=$(docker inspect --format '{{.Image}}' "$container_id")
      image_ref=$(docker inspect --format '{{.Config.Image}}' "$container_id")
      [[ "$image_ref" != sha256:* && "$image_ref" != *@sha256:* ]] || die "cannot protect immutable-only image reference"
      rollback_tag="sitewake-release-rollback/$service:$release_id"
      docker image inspect "$image_id" >/dev/null
      docker image tag "$image_id" "$rollback_tag"
      previous_image_ids[$service]=$image_id
      previous_image_refs[$service]=$image_ref
      rollback_tags+=("$rollback_tag")
    done
    rollback() {
      status=$?
      trap - EXIT
      rollback_status=0
      if [ "$status" -ne 0 ] && [ -n "$previous" ] && [ -d "$previous" ]; then
        for service in "${!previous_image_ids[@]}"; do
          docker image tag "${previous_image_ids[$service]}" "${previous_image_refs[$service]}" || rollback_status=1
        done
        atomic_current "$previous" || rollback_status=1
        export SITEWAKE_BUILD_SHA="$previous_build_sha"
        compose "$previous" "${profiles[@]}" up -d --no-build --force-recreate "${application_services[@]}" || rollback_status=1
        restored=0
        for attempt in $(seq 1 24); do
          response=$(curl --fail --silent --show-error --max-time 8 http://127.0.0.1:3000/api/health || true)
          if grep -Fq '"status":"ready"' <<<"$response" && grep -Fq '"runtime":"container"' <<<"$response" && grep -Fq "\"buildSha\":\"$previous_build_sha\"" <<<"$response"; then restored=1; break; fi
          sleep 5
        done
        [ "$restored" -eq 1 ] || rollback_status=1
      elif [ "$status" -ne 0 ]; then rm -f "$current_link" || rollback_status=1; fi
      if [ "$status" -ne 0 ]; then
        for rollback_tag in "${rollback_tags[@]}"; do docker image rm "$rollback_tag" >/dev/null 2>&1 || true; done
      fi
      if [ "$rollback_status" -ne 0 ]; then
        echo "FATAL: release rollback failed health verification" >&2
        exit 125
      fi
      exit "$status"
    }
    trap rollback EXIT
    atomic_current "$release"
    export SITEWAKE_BUILD_SHA="$build_sha"
    export SITEWAKE_MAINTENANCE_TOKEN="$(openssl rand -hex 32)"
    compose "$release" "${profiles[@]}" build control-plane capability-v2-runtime-launcher authoring-worker "${code_optional_services[@]}"
    compose "$release" up -d --no-build postgres minio minio-init capability-v2-runtime-launcher control-plane
    compose "$release" exec -T control-plane node scripts/run-capability-center-migration.mjs --schema-only </dev/null
    compose "$release" exec -T control-plane node scripts/run-capability-center-migration.mjs </dev/null
    # Historical catalog backfill is explicit one-time maintenance, not CD.
    compose "$release" "${profiles[@]}" up -d --no-build --force-recreate authoring-worker "${runtime_optional_services[@]}"
    for attempt in $(seq 1 24); do
      response=$(curl --fail --silent --show-error --max-time 8 http://127.0.0.1:3000/api/health || true)
      if grep -Fq '"status":"ready"' <<<"$response" \
        && grep -Fq '"runtime":"container"' <<<"$response" \
        && grep -Fq "\"buildSha\":\"$build_sha\"" <<<"$response"; then break; fi
      [ "$attempt" -lt 24 ] || die "release health check failed"
      sleep 5
    done
    # The public route is whatever SITEWAKE_PUBLIC_ORIGIN says in the runtime
    # configuration; without one there is no public check to make.
    public_origin=$(grep -E '^SITEWAKE_PUBLIC_ORIGIN=' "$runtime_env" | tail -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'" | sed 's:/*$::')
    if [ -n "$public_origin" ]; then
      for attempt in $(seq 1 12); do
        response=$(curl --fail --silent --show-error --max-time 10 "$public_origin/api/health" || true)
        if grep -Fq '"status":"ready"' <<<"$response" \
          && grep -Fq '"runtime":"container"' <<<"$response" \
          && grep -Fq "\"buildSha\":\"$build_sha\"" <<<"$response"; then break; fi
        [ "$attempt" -lt 12 ] || die "public release health check failed"
        sleep 5
      done
    fi
    verify_expected_sha "$expected_sha"
    trap - EXIT
    for rollback_tag in "${rollback_tags[@]}"; do docker image rm "$rollback_tag" >/dev/null 2>&1 || true; done
    docker image prune -f >/dev/null || true
    ;;
  *) die "unknown command" ;;
esac
