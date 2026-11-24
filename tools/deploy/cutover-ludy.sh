#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Cuts a deployed Ludy pilot compose stack over from legacy crove_* Docker volumes and CROVE_* env vars
# to ludy_* / COMPOSE_PROJECT_NAME=ludy without losing data (#3972, ADR-0054).
#
#   cutover-ludy.sh inspect           [--dir <abs>] [--env-file <abs>] [--overlay-dir <abs>]
#   cutover-ludy.sh cutover-stack     [--dir <abs>] [--env-file <abs>] --overlay-dir <abs> [--smoke-url <url>]
#   cutover-ludy.sh switch-wal        [--dir <abs>] [--env-file <abs>] --overlay-dir <abs>
#   cutover-ludy.sh prune-old-volumes [--dir <abs>] [--env-file <abs>]
#   cutover-ludy.sh rewrite-env       <input-env> <output-env>
#
# Security & compatibility rules:
# - Must parse and run on both Bash 3.2 (macOS tests) and Bash 4+/5+ (Ubuntu pilot host): no declare -A or mapfile.
# - Never prints secret values (DB passwords, keys, full DATABASE_URLs with credentials).
# - Acquires $DEPLOY_DIR/.deploy/lock (shared with deploy.sh) for any mutating host operation.
set -euo pipefail

readonly EXIT_FAILED=1 EXIT_USAGE=2
# Matches postgres:17 pin in docker-compose.yml and tools/wal/Dockerfile.
readonly VOLUME_COPY_IMAGE='postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3'

export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
unset LUDY_CONTEXT_TOKEN_KEY CROVE_CONTEXT_TOKEN_KEY

DEPLOY_DIR="${LUDY_DEPLOY_DIR:-${CROVE_DEPLOY_DIR:-/opt/crove}}"
ENV_FILE="${LUDY_ENV_FILE:-${CROVE_ENV_FILE:-}}"
OVERLAY_DIR=''
SMOKE_URL=''
WAIT_TIMEOUT="${LUDY_WAIT_TIMEOUT:-${CROVE_WAIT_TIMEOUT:-600}}"
READY_TIMEOUT="${LUDY_READY_TIMEOUT:-${CROVE_READY_TIMEOUT:-300}}"
WORKER_SETTLE="${LUDY_WORKER_SETTLE:-${CROVE_WORKER_SETTLE:-15}}"

log() { printf '[cutover] %s\n' "$*" 2>/dev/null || true; }
err() { printf '[cutover] ERROR: %s\n' "$*" >&2 2>/dev/null || true; }
die() {
  err "$2"
  exit "$1"
}

valid_abs_path() {
  local re='^(/[A-Za-z0-9._/@+-]*|[A-Za-z]:/[A-Za-z0-9._/@+-]*)$'
  [ -n "$1" ] || return 1
  [[ "$1" != *..* ]] || return 1
  [[ "$1" =~ $re ]]
}

valid_smoke_url() {
  local re='^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._~/-]*)?$'
  [[ "$1" =~ $re ]]
}

OPT_SHIFT=0
parse_common_option() {
  case "$1" in
    --dir | --env-file | --overlay-dir | --smoke-url)
      (($# >= 2)) || die "$EXIT_USAGE" "$1 requires a value"
      OPT_SHIFT=2
      case "$1" in
        --dir) DEPLOY_DIR="$2" ;;
        --env-file) ENV_FILE="$2" ;;
        --overlay-dir) OVERLAY_DIR="$2" ;;
        --smoke-url) SMOKE_URL="$2" ;;
      esac
      ;;
    *) OPT_SHIFT=0 ;;
  esac
}

require_paths() {
  local need_overlay="${1:-0}"
  valid_abs_path "$DEPLOY_DIR" || die "$EXIT_USAGE" "--dir must be a clean absolute path: '$DEPLOY_DIR'"
  [ -n "$ENV_FILE" ] || ENV_FILE="$DEPLOY_DIR/.env"
  valid_abs_path "$ENV_FILE" || die "$EXIT_USAGE" "--env-file must be a clean absolute path: '$ENV_FILE'"
  if [ "$need_overlay" = 1 ]; then
    valid_abs_path "$OVERLAY_DIR" || die "$EXIT_USAGE" "--overlay-dir must be a clean absolute path: '$OVERLAY_DIR'"
  elif [ -n "$OVERLAY_DIR" ]; then
    valid_abs_path "$OVERLAY_DIR" || die "$EXIT_USAGE" "--overlay-dir must be a clean absolute path: '$OVERLAY_DIR'"
  fi
  if [ -n "$SMOKE_URL" ]; then
    valid_smoke_url "$SMOKE_URL" || die "$EXIT_USAGE" "--smoke-url must be an http(s) URL: '$SMOKE_URL'"
  fi
  [ -f "$ENV_FILE" ] || die "$EXIT_USAGE" "env file not found: $ENV_FILE"
  if [ "$need_overlay" = 1 ]; then
    [ -d "$OVERLAY_DIR" ] || die "$EXIT_USAGE" "--overlay-dir not found: $OVERLAY_DIR"
  fi
}

require_docker_compose() {
  command -v docker >/dev/null || die "$EXIT_USAGE" 'docker is not installed'
  command -v curl >/dev/null || die "$EXIT_USAGE" 'curl is not installed'
  local v major minor num_re='^[0-9]+$'
  v="$(docker compose version --short 2>/dev/null)" || die "$EXIT_USAGE" 'docker compose plugin is required'
  v="${v#v}"
  major="${v%%.*}"
  minor="${v#*.}"
  minor="${minor%%.*}"
  [[ "$major" =~ $num_re && "$minor" =~ $num_re ]] || die "$EXIT_USAGE" "unexpected docker compose version: $v"
  ((major > 2 || (major == 2 && minor >= 24))) || die "$EXIT_USAGE" "docker compose v2.24 or newer is required (found $v)"
}

state_dir() { printf '%s/.deploy' "$DEPLOY_DIR"; }

LOCK_HELD=0
READY_URL=''
CREATED_LUDY_VOLUMES=()
LUDY_VOLUMES_COMMITTED=0
STAGE_DIR=''
ROLLBACK_ARMED=0
ROLLBACK_BACKUP_DIR=''
ROLLBACK_OLD_PROJECT='crove'
WAL_ROLLBACK_ARMED=0
WAL_ROLLBACK_ENV=''
WAL_ROLLBACK_COMPOSE=''
WAL_ROLLBACK_PROJECT=''
TEMP_FILES=()

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "${ROLLBACK_ARMED:-0}" = 1 ]; then
    rollback_cutover_stack || true
  fi
  if [ "$rc" -ne 0 ] && [ "${WAL_ROLLBACK_ARMED:-0}" = 1 ]; then
    rollback_switch_wal || true
  fi
  local f
  for f in "${TEMP_FILES[@]+"${TEMP_FILES[@]}"}"; do
    if [ -n "$f" ] && [ -f "$f" ]; then rm -f "$f"; fi
  done
  if [ -n "${STAGE_DIR:-}" ] && [ -d "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi
  if [ "$LOCK_HELD" = 1 ]; then rm -rf "$(state_dir)/lock"; fi
}
trap cleanup EXIT

stage_overlays() {
  local stamp="$1"
  STAGE_DIR="$(state_dir)/cutover-stage-$stamp"
  (
    umask 077
    rm -rf "$STAGE_DIR"
    mkdir -p "$STAGE_DIR"
    if [ -f "$OVERLAY_DIR/deploy.sh" ]; then cp "$OVERLAY_DIR/deploy.sh" "$STAGE_DIR/deploy.sh"; fi
    if [ -d "$OVERLAY_DIR/caddy" ]; then cp -R "$OVERLAY_DIR/caddy" "$STAGE_DIR/caddy"; fi
    if [ -d "$OVERLAY_DIR/backup" ]; then cp -R "$OVERLAY_DIR/backup" "$STAGE_DIR/backup"; fi
    if [ -d "$OVERLAY_DIR/wal" ]; then cp -R "$OVERLAY_DIR/wal" "$STAGE_DIR/wal"; fi
  )
  chmod 700 "$STAGE_DIR"
}

acquire_lock() {
  (umask 077 && mkdir -p "$(state_dir)") && chmod 700 "$(state_dir)"
  local lock pid
  lock="$(state_dir)/lock"
  if ! mkdir "$lock" 2>/dev/null; then
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      die "$EXIT_USAGE" "another deploy or cutover (pid $pid) is running"
    fi
    if [ -z "$pid" ] && [ -z "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      die "$EXIT_USAGE" 'another deploy or cutover is starting'
    fi
    log "removing stale lock left by pid ${pid:-unknown}"
    rm -rf "$lock"
    mkdir "$lock" || die "$EXIT_USAGE" "cannot acquire lock $lock"
  fi
  printf '%s\n' "$$" >"$lock/pid"
  LOCK_HELD=1
}

# Reads the effective last non-comment assignment for an environment variable key (names allowlisted only).
env_last_value() {
  local key="$1" file="${2:-$ENV_FILE}" line raw val=''
  local assign_re='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*[=:](.*)$'
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ $assign_re ]]; then
      if [ "${BASH_REMATCH[2]}" = "$key" ]; then
        raw="${BASH_REMATCH[3]}"
        raw="${raw#"${raw%%[![:space:]]*}"}"
        case "$raw" in
          \'*) raw="${raw#\'}"; val="${raw%%\'*}" ;;
          \"*) raw="${raw#\"}"; val="${raw%%\"*}" ;;
          *)
            raw="${raw%%[[:space:]]#*}"
            val="${raw%"${raw##*[![:space:]]}"}"
            ;;
        esac
      fi
    fi
  done <"$file"
  printf '%s' "$val"
}

env_or_default() {
  local v
  v="$(env_last_value "$1")"
  printf '%s' "${v:-$2}"
}

env_compose_file_lists() {
  local val
  val="$(env_last_value COMPOSE_FILE)"
  [ -n "$val" ] && [[ "$val" == *"$1"* ]]
}

pilot_layout() {
  env_compose_file_lists compose.pilot.yml
}

# Exports release image variables from the active release so compose.host.yml references resolve identically to deploy.sh.
RELEASE_BUILD=''
export_release_images() {
  local current='' rel_file
  if [ -f "$(state_dir)/current" ]; then
    current="$(cat "$(state_dir)/current" 2>/dev/null || true)"
  fi
  [ -n "$current" ] || return 0
  rel_file="$DEPLOY_DIR/releases/$current/release.env"
  [ -f "$rel_file" ] || return 0
  local img ext med bld
  img="$(sed -n 's/^IMAGE=//p' "$rel_file" | head -n 1)"
  ext="$(sed -n 's/^EXTRACT_IMAGE=//p' "$rel_file" | head -n 1)"
  med="$(sed -n 's/^MEDIA_IMAGE=//p' "$rel_file" | head -n 1)"
  bld="$(sed -n 's/^BUILD=//p' "$rel_file" | head -n 1)"
  RELEASE_BUILD="$bld"
  if [ -n "$img" ]; then export LUDY_IMAGE="$img" CROVE_IMAGE="$img"; fi
  if [ -n "$ext" ]; then export LUDY_EXTRACT_IMAGE="$ext" CROVE_EXTRACT_IMAGE="$ext"; fi
  if [ -n "$med" ]; then export LUDY_MEDIA_IMAGE="$med" CROVE_MEDIA_IMAGE="$med"; fi
}

dc_proj() {
  local proj="$1"
  shift
  local args=(compose --project-name "$proj" --project-directory "$DEPLOY_DIR" --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml")
  if pilot_layout && [ -f "$DEPLOY_DIR/compose.pilot.yml" ]; then args+=(-f "$DEPLOY_DIR/compose.pilot.yml"); fi
  if [ -f "$DEPLOY_DIR/docker-compose.override.yml" ]; then args+=(-f "$DEPLOY_DIR/docker-compose.override.yml"); fi
  if [ -f "$DEPLOY_DIR/compose.wal.yml" ]; then args+=(-f "$DEPLOY_DIR/compose.wal.yml"); fi
  if [ -f "$DEPLOY_DIR/compose.host.yml" ]; then args+=(-f "$DEPLOY_DIR/compose.host.yml"); fi
  docker "${args[@]}" "$@"
}

# Fixed mapping from legacy CROVE_* variables to LUDY_*. Keep parallel arrays for Bash 3.2 compatibility.
readonly CROVE_OLD_KEYS=(
  CROVE_DOMAIN
  CROVE_UPSTREAM
  CROVE_MODULES
  CROVE_APP_DB_PASSWORD
  CROVE_WORKER_DB_PASSWORD
  CROVE_PROBER_DB_PASSWORD
  CROVE_REPORTER_DB_PASSWORD
  CROVE_CONTEXT_TOKEN_KEY
  CROVE_SHARED_DATABASE
  CROVE_ALLOW_ALL_IN_ONE
  CROVE_DIR
  CROVE_DEPLOY_DIR
  CROVE_ENV_FILE
  CROVE_KEEP_RELEASES
  CROVE_KEEP_ENV_BACKUPS
  CROVE_WORKER_SETTLE
  CROVE_READY_TIMEOUT
  CROVE_WAIT_TIMEOUT
  CROVE_SMOKE_POLL_SECONDS
  CROVE_SMOKE_URL
  CROVE_APP_BUILD_POLL
  CROVE_APP_BUILD_TIMEOUT
  CROVE_IMAGE
  CROVE_EXTRACT_IMAGE
  CROVE_MEDIA_IMAGE
)

readonly CROVE_NEW_KEYS=(
  LUDY_DOMAIN
  LUDY_UPSTREAM
  LUDY_MODULES
  LUDY_APP_DB_PASSWORD
  LUDY_WORKER_DB_PASSWORD
  LUDY_PROBER_DB_PASSWORD
  LUDY_REPORTER_DB_PASSWORD
  LUDY_CONTEXT_TOKEN_KEY
  LUDY_SHARED_DATABASE
  LUDY_ALLOW_ALL_IN_ONE
  LUDY_DIR
  LUDY_DEPLOY_DIR
  LUDY_ENV_FILE
  LUDY_KEEP_RELEASES
  LUDY_KEEP_ENV_BACKUPS
  LUDY_WORKER_SETTLE
  LUDY_READY_TIMEOUT
  LUDY_WAIT_TIMEOUT
  LUDY_SMOKE_POLL_SECONDS
  LUDY_SMOKE_URL
  LUDY_APP_BUILD_POLL
  LUDY_APP_BUILD_TIMEOUT
  LUDY_IMAGE
  LUDY_EXTRACT_IMAGE
  LUDY_MEDIA_IMAGE
)

key_map_index() {
  local needle="$1" i
  for ((i = 0; i < ${#CROVE_OLD_KEYS[@]}; i++)); do
    if [ "${CROVE_OLD_KEYS[$i]}" = "$needle" ]; then
      printf '%s' "$i"
      return 0
    fi
  done
  return 1
}

target_map_index() {
  local needle="$1" i
  for ((i = 0; i < ${#CROVE_NEW_KEYS[@]}; i++)); do
    if [ "${CROVE_NEW_KEYS[$i]}" = "$needle" ]; then
      printf '%s' "$i"
      return 0
    fi
  done
  return 1
}

# Rewrites crove_<role>: in an explicit DB URL assignment RHS without revealing or altering passwords/hosts.
rewrite_db_url_rhs() {
  local key="$1" rhs="$2" lead='' trimmed scheme role rest
  local db_url_re='^(["'\'']?(postgres|postgresql)://)crove_(app|worker|prober|reporter|tenant|admin):(.*)$'
  case "$key" in
    DATABASE_URL | WORKER_DATABASE_URL | PROBER_DATABASE_URL | REPORTER_DATABASE_URL) ;;
    *) printf '%s' "$rhs"; return 0 ;;
  esac
  lead="${rhs%%[![:space:]]*}"
  trimmed="${rhs#"$lead"}"
  if [[ "$trimmed" =~ $db_url_re ]]; then
    scheme="${BASH_REMATCH[1]}"
    role="${BASH_REMATCH[3]}"
    rest="${BASH_REMATCH[4]}"
    printf '%s%sludy_%s:%s' "$lead" "$scheme" "$role" "$rest"
  else
    printf '%s' "$rhs"
  fi
}

# Pure-bash env rewriter: renames CROVE_* -> LUDY_* (preferring existing LUDY_* / keeping last duplicate),
# sets COMPOSE_PROJECT_NAME=ludy once, rewrites crove_<role>: DB URL usernames, and preserves comments & CRLF.
rewrite_env_file() {
  local src="$1" dst="$2"
  local assign_re='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*[=:](.*)$'
  local split_re='^([[:space:]]*(export[[:space:]]+)?)([A-Za-z_][A-Za-z0-9_]*)([[:space:]]*[=:])(.*)$'
  [ -f "$src" ] || die "$EXIT_USAGE" "env source not found: $src"
  local ludy_has=() crove_last=() i lineno=0 line line_cr cr_seen=0 lf_seen=0 last_compose=0
  for ((i = 0; i < ${#CROVE_NEW_KEYS[@]}; i++)); do
    ludy_has[i]=0
    crove_last[i]=0
  done

  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    if [[ "$line" == *$'\r' ]]; then
      line="${line%$'\r'}"
      cr_seen=$((cr_seen + 1))
    else
      lf_seen=$((lf_seen + 1))
    fi
    if [[ "$line" =~ $assign_re ]]; then
      local key="${BASH_REMATCH[2]}" idx
      if [ "$key" = COMPOSE_PROJECT_NAME ]; then
        last_compose=$lineno
      elif idx="$(target_map_index "$key")"; then
        ludy_has[idx]=1
      elif idx="$(key_map_index "$key")"; then
        crove_last[idx]=$lineno
      fi
    fi
  done <"$src"

  local default_cr=''
  if ((cr_seen > 0 && lf_seen == 0)); then default_cr=$'\r'; fi

  lineno=0
  local wrote_compose=0
  : >"$dst"
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    if [[ "$line" == *$'\r' ]]; then
      line="${line%$'\r'}"
      line_cr=$'\r'
    else
      line_cr=''
    fi
    if [[ "$line" =~ $split_re ]]; then
      local prefix="${BASH_REMATCH[1]}" key="${BASH_REMATCH[3]}" sep="${BASH_REMATCH[4]}" rhs="${BASH_REMATCH[5]}" idx
      if [ "$key" = COMPOSE_PROJECT_NAME ]; then
        if ((lineno == last_compose)); then
          printf '%sCOMPOSE_PROJECT_NAME=ludy%s\n' "$prefix" "$line_cr" >>"$dst"
          wrote_compose=1
        fi
        continue
      fi
      if idx="$(key_map_index "$key")"; then
        if ((ludy_has[idx] == 1)) || ((lineno != crove_last[idx])); then
          continue
        fi
        printf '%s%s%s%s%s\n' "$prefix" "${CROVE_NEW_KEYS[$idx]}" "$sep" "$rhs" "$line_cr" >>"$dst"
        continue
      fi
      local new_rhs
      new_rhs="$(rewrite_db_url_rhs "$key" "$rhs")"
      printf '%s%s%s%s%s\n' "$prefix" "$key" "$sep" "$new_rhs" "$line_cr" >>"$dst"
    else
      printf '%s%s\n' "$line" "$line_cr" >>"$dst"
    fi
  done <"$src"

  if ((wrote_compose == 0)); then
    printf 'COMPOSE_PROJECT_NAME=ludy%s\n' "$default_cr" >>"$dst"
  fi
}

write_env_in_place() {
  local new_content_file="$1"
  [ -w "$ENV_FILE" ] || die "$EXIT_USAGE" "$ENV_FILE must be writable"
  cat "$new_content_file" >"$ENV_FILE" && cmp -s "$new_content_file" "$ENV_FILE"
}

upsert_env_kv_file() {
  local src="$1" dst="$2" k1="$3" v1="$4" k2="$5" v2="$6" k3="$7" v3="$8"
  local split_re='^([[:space:]]*(export[[:space:]]+)?)([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*[=:]'
  local line line_cr cr_seen=0 lf_seen=0 s1=0 s2=0 s3=0
  : >"$dst"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == *$'\r' ]]; then line="${line%$'\r'}"; line_cr=$'\r'; cr_seen=$((cr_seen + 1)); else line_cr=''; lf_seen=$((lf_seen + 1)); fi
    if [[ "$line" =~ $split_re ]]; then
      local key="${BASH_REMATCH[3]}" prefix="${BASH_REMATCH[1]}"
      if [ "$key" = "$k1" ]; then
        if ((s1 == 0)); then printf '%s%s=%s%s\n' "$prefix" "$k1" "$v1" "$line_cr" >>"$dst"; s1=1; fi
        continue
      elif [ "$key" = "$k2" ]; then
        if ((s2 == 0)); then printf '%s%s=%s%s\n' "$prefix" "$k2" "$v2" "$line_cr" >>"$dst"; s2=1; fi
        continue
      elif [ "$key" = "$k3" ]; then
        if ((s3 == 0)); then printf '%s%s=%s%s\n' "$prefix" "$k3" "$v3" "$line_cr" >>"$dst"; s3=1; fi
        continue
      fi
    fi
    printf '%s%s\n' "$line" "$line_cr" >>"$dst"
  done <"$src"
  local dcr=''
  if ((cr_seen > 0 && lf_seen == 0)); then dcr=$'\r'; fi
  if ((s1 == 0)); then printf '%s=%s%s\n' "$k1" "$v1" "$dcr" >>"$dst"; fi
  if ((s2 == 0)); then printf '%s=%s%s\n' "$k2" "$v2" "$dcr" >>"$dst"; fi
  if ((s3 == 0)); then printf '%s=%s%s\n' "$k3" "$v3" "$dcr" >>"$dst"; fi
}

detect_active_project() {
  local proj
  proj="$(env_last_value COMPOSE_PROJECT_NAME)"
  if [ -n "$proj" ]; then
    printf '%s' "$proj"
    return 0
  fi
  if grep -q -E '^name:[[:space:]]*ludy[[:space:]]*$' "$DEPLOY_DIR/docker-compose.yml" 2>/dev/null; then
    printf 'ludy'
  else
    printf 'crove'
  fi
}

check_expected_schemas() {
  local proj="$1" schemas non_ludy count
  schemas="$(dc_proj "$proj" exec -T db psql -U postgres -d postgres -Atc \
    "SELECT nspname FROM pg_namespace WHERE nspname ~ '^(crove|ludy)_' ORDER BY 1;")"
  non_ludy="$(printf '%s\n' "$schemas" | grep -E '^crove_' || true)"
  if [ -n "$non_ludy" ]; then
    err "unexpected legacy crove_* schemas remain (deploy v0.3.10 / #3971 first): $non_ludy"
    return 1
  fi
  count="$(printf '%s\n' "$schemas" | grep -cE '^ludy_(ads|crm|finance|hr|jobs|kernel|meetings|meta|notes|projects|sign|social)$' || true)"
  if [ "$count" != 12 ]; then
    err "expected all 12 ludy_* schemas, found $count: $schemas"
    return 1
  fi
  local mig
  mig="$(dc_proj "$proj" exec -T db psql -U postgres -d postgres -Atc \
    "SELECT count(*) FROM ludy_meta.schema_migrations WHERE version = '20270316140000';")"
  [ "$mig" = 1 ] || {
    err 'migration 20270316140000 is not applied yet'
    return 1
  }
}

# Replaces an operator overlay file in $DEPLOY_DIR atomically so root-owned 0644 files can be updated whenever
# $DEPLOY_DIR itself is writable by DEPLOY_USER (matching deploy.sh activate).
copy_into_deploy_dir() {
  local src="$1" dst="$2" dir tmp
  dir="$(dirname "$dst")"
  tmp="$(mktemp "$dir/.cutover-file-tmp-XXXXXX")" || return 1
  TEMP_FILES+=("$tmp")
  cat "$src" >"$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$dst"
}

wait_local_ready() {
  local proj="$1" api_svc mapped port url deadline=$((SECONDS + READY_TIMEOUT)) num_re='^[0-9]+$'
  READY_URL=''
  if [ -n "$SMOKE_URL" ]; then
    url="${SMOKE_URL%/}"
  else
    if pilot_layout; then api_svc=api; else api_svc=crove; fi
    mapped="$(dc_proj "$proj" port "$api_svc" 8080 | head -n 1)" || return 1
    port="${mapped##*:}"
    [[ "$port" =~ $num_re ]] || return 1
    url="http://127.0.0.1:$port"
  fi
  log "waiting for $url/readyz (up to ${READY_TIMEOUT}s)"
  while :; do
    if curl --silent --show-error --fail --max-time 5 "$url/readyz" 2>/dev/null | grep -F '"ready":true' >/dev/null; then
      READY_URL="$url"
      return 0
    fi
    ((SECONDS < deadline)) || break
    sleep 3
  done
  err "timed out waiting for $url/readyz"
  return 1
}

wait_db_ready() {
  local proj="$1" i
  for i in $(seq 1 90); do
    if dc_proj "$proj" exec -T db pg_isready -q -U postgres -h /var/run/postgresql 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  err 'db did not become ready'
  return 1
}

bring_up_stack() {
  local proj="$1" start_caddy="${2:-1}" services svc has_auth=0 has_grants=0 has_worker=0 has_api=0 has_crove=0 has_prober=0 has_caddy=0
  local infra=()
  services="$(dc_proj "$proj" config --services)" || return 1
  while IFS= read -r svc; do
    case "$svc" in
      auth) has_auth=1; infra+=("$svc") ;;
      auth-grants) has_grants=1 ;;
      worker) has_worker=1 ;;
      api) has_api=1 ;;
      crove) has_crove=1 ;;
      prober) has_prober=1 ;;
      caddy)
        has_caddy=1
        if ((start_caddy)); then infra+=("$svc"); fi
        ;;
      db | migrate | usage | '') ;;
      *) infra+=("$svc") ;;
    esac
  done <<<"$services"

  log "starting database on project $proj"
  dc_proj "$proj" up -d --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" db || return 1
  wait_db_ready "$proj" || return 1

  log "verifying migrations on project $proj"
  dc_proj "$proj" run --rm --no-TTY --no-deps migrate || return 1

  if ((has_auth)); then
    log "starting Supabase Auth on project $proj"
    dc_proj "$proj" up -d --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" auth || return 1
  fi
  if ((has_grants)); then
    log "running auth-grants on project $proj"
    dc_proj "$proj" run --rm --no-TTY --no-deps auth-grants || return 1
  fi
  local rest=()
  for svc in "${infra[@]+"${infra[@]}"}"; do
    [ "$svc" = auth ] || rest+=("$svc")
  done
  if ((${#rest[@]} > 0)); then
    log "starting ${rest[*]} on project $proj"
    dc_proj "$proj" up -d --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" "${rest[@]}" || return 1
  fi
  if ((has_caddy && start_caddy)); then
    log 'restarting caddy so reloaded Caddyfile applies with admin off'
    dc_proj "$proj" restart caddy || return 1
  fi

  if ((has_worker && has_api)); then
    log "starting worker on project $proj"
    dc_proj "$proj" up -d --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" worker || return 1
    sleep "$WORKER_SETTLE"
    dc_proj "$proj" ps --status running --services | grep -x worker >/dev/null || {
      err "worker is not running on project $proj"
      return 1
    }
    log "starting api on project $proj"
    dc_proj "$proj" up -d --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" api || return 1
  elif ((has_crove)); then
    log "starting all-in-one crove service on project $proj"
    dc_proj "$proj" up -d --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" crove || return 1
  fi

  if ((has_prober)); then
    log "starting prober on project $proj"
    dc_proj "$proj" up -d --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" prober || return 1
  fi
}

do_inspect() {
  require_paths 0
  require_docker_compose
  local proj
  proj="$(detect_active_project)"
  export_release_images

  # Public workflow log hygiene (L2): avoid echoing raw DEPLOY_DIR, ENV_FILE, BACKUP_DIR, or domain hostnames.
  log "active_project=$proj env_file_present=yes"
  log "COMPOSE_FILE=$([ -n "$(env_last_value COMPOSE_FILE)" ] && echo '(set)' || echo '(unset)')"
  log "COMPOSE_PROJECT_NAME=$(env_or_default COMPOSE_PROJECT_NAME '(unset)')"
  log "LUDY_DOMAIN=$([ -n "$(env_last_value LUDY_DOMAIN)" ] && echo '(set)' || echo '(unset)') CROVE_DOMAIN=$([ -n "$(env_last_value CROVE_DOMAIN)" ] && echo '(set)' || echo '(unset)')"
  log "LUDY_MODULES=$(env_or_default LUDY_MODULES '(unset)') CROVE_MODULES=$(env_or_default CROVE_MODULES '(unset)')"
  log "WAL_STANZA=$(env_or_default WAL_STANZA '(default: crove)') BACKUP_S3_PREFIX=$(env_or_default BACKUP_S3_PREFIX '(default: crove)') WAL_DB_IMAGE=$(env_or_default WAL_DB_IMAGE '(default: crove-db:local)')"
  log "BACKUP_DIR=$([ -n "$(env_last_value BACKUP_DIR)" ] && echo '(set)' || echo '(unset)')"
  if [ -f "$(state_dir)/current" ]; then log "release_current=$(cat "$(state_dir)/current")"; fi
  if [ -f "$(state_dir)/previous" ]; then log "release_previous=$(cat "$(state_dir)/previous")"; fi

  # Report ONLY legacy CROVE_* key names present in .env, never values.
  local found_crove='' line key crove_re='^[[:space:]]*(export[[:space:]]+)?(CROVE_[A-Za-z0-9_]+)[[:space:]]*[=:]'
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ $crove_re ]]; then
      key="${BASH_REMATCH[2]}"
      case " $found_crove " in *" $key "*) ;; *) found_crove+="${found_crove:+ }$key" ;; esac
    fi
  done <"$ENV_FILE"
  log "legacy CROVE_* keys in env: ${found_crove:-none}"

  local url_key val db_user_re='^(postgres|postgresql)://([A-Za-z0-9_.-]+)[:@]'
  for url_key in DATABASE_URL WORKER_DATABASE_URL PROBER_DATABASE_URL REPORTER_DATABASE_URL; do
    val="$(env_last_value "$url_key")"
    if [ -n "$val" ]; then
      if [[ "$val" =~ $db_user_re ]]; then
        log "$url_key user=${BASH_REMATCH[2]}"
      else
        log "$url_key user=(unparsed)"
      fi
    fi
  done

  log "overlay files present: caddy=$([ -f "$DEPLOY_DIR/compose.host.yml" ] && echo yes || echo no) wal=$([ -f "$DEPLOY_DIR/compose.wal.yml" ] && echo yes || echo no)"
  if [ -f "$DEPLOY_DIR/compose.host.yml" ]; then
    log "compose.host.yml uses LUDY_DOMAIN: $(grep -q 'LUDY_DOMAIN' "$DEPLOY_DIR/compose.host.yml" && echo yes || echo no)"
  fi
  if [ -f "$DEPLOY_DIR/compose.wal.yml" ]; then
    log "compose.wal.yml supports WAL_STANZA: $(grep -q 'WAL_STANZA' "$DEPLOY_DIR/compose.wal.yml" && echo yes || echo no)"
  fi
  if [ -n "$OVERLAY_DIR" ] && [ -d "$OVERLAY_DIR" ]; then
    local pair host_rel overlay_rel cmp_status legacy_keys
    for pair in \
      'Caddyfile:caddy/Caddyfile' \
      'compose.host.yml:caddy/compose.host.yml' \
      'compose.wal.yml:backup/compose.wal.yml'; do
      host_rel="${pair%%:*}"
      overlay_rel="${pair#*:}"
      if [ -f "$DEPLOY_DIR/$host_rel" ]; then
        if [ -f "$OVERLAY_DIR/$overlay_rel" ]; then
          if cmp -s "$DEPLOY_DIR/$host_rel" "$OVERLAY_DIR/$overlay_rel"; then cmp_status='matches'; else cmp_status='differs'; fi
        else
          cmp_status='no-template'
        fi
        legacy_keys="$(grep -oE 'CROVE_[A-Z0-9_]+' "$DEPLOY_DIR/$host_rel" 2>/dev/null | sort -u | tr '\n' ',' || true)"
        legacy_keys="${legacy_keys%,}"
        log "overlay $host_rel: template=$cmp_status legacy_keys=${legacy_keys:-none}"
      fi
    done
  fi

  log 'Docker volumes matching ^(crove|ludy)_:'
  docker volume ls --format '  {{.Name}}' | grep -E '^  (crove|ludy)_' | sort || log '  (none)'

  log 'Docker db images local:'
  docker images --format '  {{.Repository}}:{{.Tag}}' | grep -E '^  (crove|ludy)-db:' || log '  (none)'

  log "Compose services status (project=$proj):"
  dc_proj "$proj" ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' || true

  if dc_proj "$proj" ps --status running --services | grep -x db >/dev/null; then
    log 'PostgreSQL schemas:'
    dc_proj "$proj" exec -T db psql -U postgres -d postgres -Atc \
      "SELECT nspname FROM pg_namespace WHERE nspname ~ '^(crove|ludy)_' ORDER BY 1;" | sed 's/^/  /'
    local has_mig_tbl
    has_mig_tbl="$(dc_proj "$proj" exec -T db psql -U postgres -d postgres -Atc \
      "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ludy_meta' AND c.relname = 'schema_migrations';" || true)"
    if [ "$has_mig_tbl" = 1 ]; then
      log 'PostgreSQL migration 20270316140000 present:'
      dc_proj "$proj" exec -T db psql -U postgres -d postgres -Atc \
        "SELECT version || ' (' || applied_at || ')' FROM ludy_meta.schema_migrations WHERE version = '20270316140000';" | sed 's/^/  /'
    else
      log 'PostgreSQL migration 20270316140000 present: (ludy_meta.schema_migrations not created yet)'
    fi
    log 'Active crove_* sessions:'
    dc_proj "$proj" exec -T db psql -U postgres -d postgres -Atc \
      "SELECT coalesce(nullif(string_agg(usename || ':' || count::text, ', '), ''), 'none') FROM (SELECT usename, count(*) FROM pg_stat_activity WHERE usename LIKE 'crove_%' GROUP BY 1) s;" | sed 's/^/  /'
  else
    log 'db container is not running under active project'
  fi
}

check_host_compose_safe() {
  local file="$1" line in_services=0 svc_indent=''
  local top_services_re='^services:[[:space:]]*(#.*)?$'
  local top_other_re='^[^[:space:]#]'
  local kv_re='^([[:space:]]+)([A-Za-z0-9_.-]+):[[:space:]]*(\{\}[[:space:]]*)?(#.*)?$'
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "${line#"${line%%[![:space:]]*}"}" in '' | \#*) continue ;; esac
    if ((in_services == 0)); then
      if [[ "$line" =~ $top_services_re ]]; then
        in_services=1
      fi
      continue
    fi
    if [[ "$line" =~ $top_other_re ]]; then
      break
    fi
    if [[ "$line" =~ $kv_re ]]; then
      local indent="${BASH_REMATCH[1]}" svc="${BASH_REMATCH[2]}"
      if [ -z "$svc_indent" ]; then
        svc_indent="$indent"
      fi
      if [ "$indent" = "$svc_indent" ]; then
        case "$svc" in
          caddy | mailpit) ;;
          *)
            err "refusing to overwrite $file: contains unexpected custom service '$svc' (expected only caddy and mailpit)"
            return 1
            ;;
        esac
      fi
    fi
  done <"$file"
}

rollback_cutover_stack() {
  [ "${ROLLBACK_ARMED:-0}" = 1 ] || return 0
  ROLLBACK_ARMED=0
  if [ "${LUDY_VOLUMES_COMMITTED:-0}" = 1 ]; then
    err "cutover-stack failed AFTER project ludy started; preserving ludy_* volumes and pre-cutover backups without deleting data or restarting $ROLLBACK_OLD_PROJECT"
    return 0
  fi
  err "cutover-stack failed before project ludy started; rolling back to project $ROLLBACK_OLD_PROJECT"
  dc_proj ludy down --remove-orphans >/dev/null 2>&1 || true
  if ((${#CREATED_LUDY_VOLUMES[@]} > 0)); then
    docker volume rm "${CREATED_LUDY_VOLUMES[@]}" >/dev/null 2>&1 || true
  fi
  if [ -n "$ROLLBACK_BACKUP_DIR" ] && [ -f "$ROLLBACK_BACKUP_DIR/env.pre-cutover" ]; then
    write_env_in_place "$ROLLBACK_BACKUP_DIR/env.pre-cutover" || err 'failed to restore env file!'
    local f
    for f in Caddyfile compose.host.yml compose.wal.yml; do
      if [ -f "$ROLLBACK_BACKUP_DIR/$f" ]; then
        copy_into_deploy_dir "$ROLLBACK_BACKUP_DIR/$f" "$DEPLOY_DIR/$f" || true
      fi
    done
  fi
  bring_up_stack "$ROLLBACK_OLD_PROJECT" || err "AUTOMATIC ROLLBACK FAILED: restore manually using $ROLLBACK_BACKUP_DIR"
}

do_cutover_stack() {
  require_paths 1
  require_docker_compose
  [ -w "$ENV_FILE" ] && [ -w "$DEPLOY_DIR" ] || die "$EXIT_USAGE" "$ENV_FILE and $DEPLOY_DIR must be writable"
  [ -f "$OVERLAY_DIR/deploy.sh" ] || die "$EXIT_USAGE" "missing $OVERLAY_DIR/deploy.sh"
  [ -f "$OVERLAY_DIR/caddy/Caddyfile" ] && [ -f "$OVERLAY_DIR/caddy/compose.host.yml" ] || die "$EXIT_USAGE" "missing caddy overlays in $OVERLAY_DIR/caddy"
  if [ -f "$DEPLOY_DIR/compose.wal.yml" ]; then
    [ -f "$OVERLAY_DIR/backup/compose.wal.yml" ] || die "$EXIT_USAGE" "missing $OVERLAY_DIR/backup/compose.wal.yml"
  fi
  if [ -f "$DEPLOY_DIR/compose.host.yml" ]; then
    check_host_compose_safe "$DEPLOY_DIR/compose.host.yml" || exit "$EXIT_FAILED"
  fi

  acquire_lock
  trap '' HUP PIPE
  export_release_images

  local proj
  proj="$(detect_active_project)"
  if [ "$proj" = ludy ]; then
    die "$EXIT_USAGE" 'active COMPOSE_PROJECT_NAME is already ludy; run inspect to verify status'
  fi
  ROLLBACK_OLD_PROJECT="$proj"

  dc_proj "$proj" ps --status running --services | grep -x db >/dev/null || die "$EXIT_FAILED" "db is not running under project $proj"
  check_expected_schemas "$proj" || exit "$EXIT_FAILED"

  local src_vols=() vol
  while IFS= read -r vol; do
    [ -n "$vol" ] || continue
    case "$vol" in
      "${proj}_media-scratch") log "skipping ephemeral volume $vol" ;;
      *) src_vols+=("$vol") ;;
    esac
  done < <(docker volume ls --format '{{.Name}}' | grep -E "^${proj}_" | sort || true)

  ((${#src_vols[@]} > 0)) || die "$EXIT_FAILED" "no Docker volumes found matching ${proj}_*"
  printf '%s\n' "${src_vols[@]}" | grep -x "${proj}_db-data" >/dev/null || die "$EXIT_FAILED" "missing required ${proj}_db-data volume"

  log "pulling helper copy image $VOLUME_COPY_IMAGE if needed"
  docker pull --quiet "$VOLUME_COPY_IMAGE" >/dev/null

  # Fail closed BEFORE mutating anything if any target ludy_* volume is already populated.
  for vol in "${src_vols[@]}"; do
    local suffix="${vol#"${proj}_"}"
    local dst="ludy_$suffix"
    if docker volume inspect "$dst" >/dev/null 2>&1; then
      local existing
      existing="$(docker run --rm --network none -v "${dst}:/dst:ro" --entrypoint sh "$VOLUME_COPY_IMAGE" -c 'find /dst -mindepth 1 -maxdepth 1 -print -quit')"
      if [ -n "$existing" ]; then
        die "$EXIT_FAILED" "target volume $dst already exists and is non-empty; refusing to overwrite"
      fi
    fi
  done

  local stamp backup_dir f
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="$(state_dir)/cutover-backup-$stamp"
  (
    umask 077
    mkdir -p "$backup_dir"
    cp "$ENV_FILE" "$backup_dir/env.pre-cutover"
    chmod 0600 "$backup_dir/env.pre-cutover"
    for f in Caddyfile compose.host.yml compose.wal.yml; do
      if [ -f "$DEPLOY_DIR/$f" ]; then cp "$DEPLOY_DIR/$f" "$backup_dir/$f"; fi
    done
  )
  ROLLBACK_BACKUP_DIR="$backup_dir"
  stage_overlays "$stamp"

  log 'taking logical PostgreSQL backup before stopping stack'
  (
    umask 077
    dc_proj "$proj" exec -T db pg_dump -U postgres -d postgres --format=custom --exclude-table-data=ludy_kernel.context_key >"$backup_dir/db.dump"
    [ -s "$backup_dir/db.dump" ]
  )
  dc_proj "$proj" exec -T db pg_restore --list <"$backup_dir/db.dump" >/dev/null

  local env_tmp
  env_tmp="$(umask 077 && mktemp "$(state_dir)/.env.cutover-tmp-XXXXXX")"
  TEMP_FILES+=("$env_tmp")
  rewrite_env_file "$ENV_FILE" "$env_tmp"

  # Arm EXIT-based rollback before stopping services or copying volumes.
  LUDY_VOLUMES_COMMITTED=0
  ROLLBACK_ARMED=1

  log "stopping running $proj services cleanly for offline volume copy"
  local stop_list=() s
  while IFS= read -r s; do
    [ -n "$s" ] && [ "$s" != db ] && stop_list+=("$s")
  done < <(dc_proj "$proj" ps --status running --services || true)
  if ((${#stop_list[@]} > 0)); then
    dc_proj "$proj" stop "${stop_list[@]}"
  fi
  dc_proj "$proj" stop -t 60 db

  for vol in "${src_vols[@]}"; do
    local suffix="${vol#"${proj}_"}"
    local dst="ludy_$suffix"
    if ! docker volume inspect "$dst" >/dev/null 2>&1; then
      docker volume create \
        --label com.docker.compose.project=ludy \
        --label "com.docker.compose.volume=$suffix" \
        --label com.docker.compose.version=2 \
        "$dst" >/dev/null
      CREATED_LUDY_VOLUMES+=("$dst")
    fi
    log "copying Docker volume $vol -> $dst"
    docker run --rm --network none \
      -v "${vol}:/src:ro" \
      -v "${dst}:/dst" \
      --entrypoint bash "$VOLUME_COPY_IMAGE" -c '
        set -euo pipefail
        tar -C /src --numeric-owner -cpf - . | tar -C /dst --numeric-owner -xpf -
        src_count="$(find /src -mindepth 1 | wc -l | tr -d " ")"
        dst_count="$(find /dst -mindepth 1 | wc -l | tr -d " ")"
        [ "$src_count" -eq "$dst_count" ] || { echo "volume count mismatch for $1 -> $2: $src_count != $dst_count" >&2; exit 1; }
        if [ -f /src/PG_VERSION ]; then
          [ -f /dst/PG_VERSION ] && [ -f /dst/global/pg_control ] || { echo "missing PostgreSQL control files in $2" >&2; exit 1; }
        fi
        printf "verified %s -> %s (%s entries)\n" "$1" "$2" "$dst_count"
      ' _ "$vol" "$dst"
  done

  log "removing stopped containers/networks of $proj (preserving ${proj}_* volumes)"
  dc_proj "$proj" down --remove-orphans

  if [ -f "$DEPLOY_DIR/compose.host.yml" ]; then
    check_host_compose_safe "$DEPLOY_DIR/compose.host.yml" || return 1
    log 'updating Caddyfile and compose.host.yml from staged overlays'
    copy_into_deploy_dir "$STAGE_DIR/caddy/Caddyfile" "$DEPLOY_DIR/Caddyfile"
    copy_into_deploy_dir "$STAGE_DIR/caddy/compose.host.yml" "$DEPLOY_DIR/compose.host.yml"
  fi
  if [ -f "$DEPLOY_DIR/compose.wal.yml" ]; then
    [ -f "$STAGE_DIR/backup/compose.wal.yml" ] || die "$EXIT_FAILED" 'missing staged backup/compose.wal.yml'
    log 'updating compose.wal.yml from staged overlay'
    copy_into_deploy_dir "$STAGE_DIR/backup/compose.wal.yml" "$DEPLOY_DIR/compose.wal.yml"
  fi

  log 'rewriting env file with LUDY_* and COMPOSE_PROJECT_NAME=ludy'
  write_env_in_place "$env_tmp"
  rm -f "$env_tmp"

  dc_proj ludy config --quiet

  # Point of no return (B1): once project ludy starts containers against ludy_* volumes, rollback must NEVER
  # delete CREATED_LUDY_VOLUMES or restart stale crove volumes. Keep caddy offline until checks pass.
  LUDY_VOLUMES_COMMITTED=1
  bring_up_stack ludy 0

  wait_local_ready ludy
  log 'running loopback smoke check on local API'
  LUDY_DEPLOY_DIR="$DEPLOY_DIR" LUDY_ENV_FILE="$ENV_FILE" \
    bash "$STAGE_DIR/deploy.sh" smoke "$READY_URL" ${RELEASE_BUILD:+"$RELEASE_BUILD"}

  check_expected_schemas ludy
  local legacy_sessions
  legacy_sessions="$(dc_proj ludy exec -T db psql -U postgres -d postgres -Atc \
    "SELECT count(*) FROM pg_stat_activity WHERE usename LIKE 'crove_%';")"
  if [ "$legacy_sessions" != 0 ]; then
    err "found $legacy_sessions active crove_* sessions after cutover"
    return 1
  fi

  if dc_proj ludy config --services | grep -x caddy >/dev/null; then
    log 'starting caddy on project ludy after checks passed'
    dc_proj ludy up -d --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" caddy
    dc_proj ludy restart caddy
  fi

  ROLLBACK_ARMED=0
  log "cutover-stack SUCCEEDED: project=ludy running cleanly; old ${proj}_* volumes retained until prune-old-volumes"
}

rollback_switch_wal() {
  [ "${WAL_ROLLBACK_ARMED:-0}" = 1 ] || return 0
  WAL_ROLLBACK_ARMED=0
  err 'switch-wal failed; restoring previous .env, compose.wal.yml, and prior pgBackRest stanza'
  if [ -n "$WAL_ROLLBACK_ENV" ] && [ -f "$WAL_ROLLBACK_ENV" ]; then
    write_env_in_place "$WAL_ROLLBACK_ENV" || true
  fi
  if [ -n "$WAL_ROLLBACK_COMPOSE" ] && [ -f "$WAL_ROLLBACK_COMPOSE" ]; then
    copy_into_deploy_dir "$WAL_ROLLBACK_COMPOSE" "$DEPLOY_DIR/compose.wal.yml" || true
  fi
  dc_proj "$WAL_ROLLBACK_PROJECT" up -d --no-build --no-deps db || true
  wait_db_ready "$WAL_ROLLBACK_PROJECT" || true
  env -u WAL_STANZA -u BACKUP_S3_PREFIX -u WAL_DB_IMAGE -u COMPOSE_PROJECT_NAME \
    LUDY_DIR="$DEPLOY_DIR" CROVE_DIR="$DEPLOY_DIR" \
    bash "$STAGE_DIR/backup/wal.sh" setup || true
}

do_switch_wal() {
  require_paths 1
  require_docker_compose
  [ "$ENV_FILE" = "$DEPLOY_DIR/.env" ] || die "$EXIT_USAGE" "switch-wal requires --env-file to be $DEPLOY_DIR/.env (wal.sh reads LUDY_DIR/.env)"
  [ -w "$ENV_FILE" ] && [ -w "$DEPLOY_DIR" ] || die "$EXIT_USAGE" "$ENV_FILE and $DEPLOY_DIR must be writable"
  env_compose_file_lists compose.wal.yml || die "$EXIT_USAGE" "COMPOSE_FILE in $ENV_FILE does not list compose.wal.yml"
  [ -f "$DEPLOY_DIR/compose.wal.yml" ] || die "$EXIT_USAGE" "missing $DEPLOY_DIR/compose.wal.yml"
  [ -f "$OVERLAY_DIR/wal/Dockerfile" ] || die "$EXIT_USAGE" "missing $OVERLAY_DIR/wal/Dockerfile"
  [ -f "$OVERLAY_DIR/backup/compose.wal.yml" ] && [ -f "$OVERLAY_DIR/backup/wal.sh" ] || die "$EXIT_USAGE" "missing backup scripts in $OVERLAY_DIR/backup"

  acquire_lock
  trap '' HUP PIPE
  export_release_images

  local proj stamp backup_env backup_compose env_tmp info_out backup_count
  proj="$(detect_active_project)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_env="$(state_dir)/env.pre-switch-wal-$stamp"
  backup_compose="$(state_dir)/compose.wal.pre-switch-wal-$stamp"
  (
    umask 077
    cp "$ENV_FILE" "$backup_env"
    chmod 0600 "$backup_env"
    cp "$DEPLOY_DIR/compose.wal.yml" "$backup_compose"
  )
  stage_overlays "$stamp"

  WAL_ROLLBACK_ENV="$backup_env"
  WAL_ROLLBACK_COMPOSE="$backup_compose"
  WAL_ROLLBACK_PROJECT="$proj"
  WAL_ROLLBACK_ARMED=1

  log 'syncing latest compose.wal.yml and building ludy-db:local'
  copy_into_deploy_dir "$STAGE_DIR/backup/compose.wal.yml" "$DEPLOY_DIR/compose.wal.yml"
  docker build -t ludy-db:local "$STAGE_DIR/wal"

  env_tmp="$(umask 077 && mktemp "$(state_dir)/.env.wal-tmp-XXXXXX")"
  TEMP_FILES+=("$env_tmp")
  upsert_env_kv_file "$ENV_FILE" "$env_tmp" WAL_STANZA ludy BACKUP_S3_PREFIX ludy WAL_DB_IMAGE 'ludy-db:local'

  write_env_in_place "$env_tmp"
  rm -f "$env_tmp"

  log 'recreating db with WAL_STANZA=ludy and image ludy-db:local'
  dc_proj "$proj" up -d --no-build --no-deps db
  wait_db_ready "$proj"

  log 'running wal.sh setup, check, and info for stanza ludy'
  env -u WAL_STANZA -u BACKUP_S3_PREFIX -u WAL_DB_IMAGE -u COMPOSE_PROJECT_NAME \
    LUDY_DIR="$DEPLOY_DIR" CROVE_DIR="$DEPLOY_DIR" bash "$STAGE_DIR/backup/wal.sh" setup
  env -u WAL_STANZA -u BACKUP_S3_PREFIX -u WAL_DB_IMAGE -u COMPOSE_PROJECT_NAME \
    LUDY_DIR="$DEPLOY_DIR" CROVE_DIR="$DEPLOY_DIR" bash "$STAGE_DIR/backup/wal.sh" check
  info_out="$(env -u WAL_STANZA -u BACKUP_S3_PREFIX -u WAL_DB_IMAGE -u COMPOSE_PROJECT_NAME \
    LUDY_DIR="$DEPLOY_DIR" CROVE_DIR="$DEPLOY_DIR" bash "$STAGE_DIR/backup/wal.sh" info)"
  # Log only redacted summary to keep S3 bucket/endpoint details out of public CI logs (L2).
  printf '%s\n' "$info_out" | grep -F 'stanza: ludy' >/dev/null || {
    err 'wal.sh info did not report stanza: ludy'
    return 1
  }
  printf '%s\n' "$info_out" | grep -F 'status: ok' >/dev/null || {
    err 'wal.sh info did not report status: ok'
    return 1
  }
  backup_count="$(printf '%s\n' "$info_out" | grep -cE '(full|diff|incr) backup:' || true)"
  log "wal.sh info verified (stanza=ludy status=ok backups=$backup_count)"

  WAL_ROLLBACK_ARMED=0
  log 'switch-wal SUCCEEDED: stanza ludy is active and checked'
}

do_prune_old_volumes() {
  require_paths 0
  require_docker_compose
  acquire_lock
  trap '' HUP PIPE
  export_release_images

  local proj
  proj="$(detect_active_project)"
  [ "$proj" = ludy ] || die "$EXIT_USAGE" "COMPOSE_PROJECT_NAME must be ludy before pruning crove_* volumes (currently $proj)"

  dc_proj ludy ps --status running --services | grep -x db >/dev/null || die "$EXIT_FAILED" 'db is not running under project ludy'
  wait_local_ready ludy || die "$EXIT_FAILED" 'ludy API /readyz is not ready'

  local ids ids_arr=() mounted='' cid
  ids="$(docker ps -aq)"
  while IFS= read -r cid; do
    [ -n "$cid" ] && ids_arr+=("$cid")
  done <<<"$ids"
  if ((${#ids_arr[@]} > 0)); then
    mounted="$(docker inspect -f '{{range .Mounts}}{{println .Name}}{{end}}' "${ids_arr[@]}" | grep -E '^crove_' | sort -u || true)"
  fi
  if [ -n "$mounted" ]; then
    die "$EXIT_FAILED" "refusing to prune: container(s) still reference crove_* volume(s): $mounted"
  fi

  local old_vols=() v need_copy_probe=0
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    old_vols+=("$v")
    case "$v" in
      crove_media-scratch) ;;
      *) need_copy_probe=1 ;;
    esac
  done < <(docker volume ls --format '{{.Name}}' | grep -E '^crove_' | sort || true)

  # L1: Verify every non-ephemeral crove_<suffix> has a valid ludy_<suffix> replacement BEFORE pruning.
  # Always require ludy_db-data to be non-empty; for other volumes (e.g. crove_files on an S3 pilot),
  # allow empty -> empty when crove_<suffix> itself is empty, and refuse if source had data.
  if ((need_copy_probe)); then
    docker pull --quiet "$VOLUME_COPY_IMAGE" >/dev/null
    for v in "${old_vols[@]}"; do
      case "$v" in
        crove_media-scratch) continue ;;
      esac
      local suffix="${v#crove_}" dst="ludy_${v#crove_}" existing src_existing
      docker volume inspect "$dst" >/dev/null 2>&1 || die "$EXIT_FAILED" "refusing to prune $v: matching replacement volume $dst does not exist"
      existing="$(docker run --rm --network none -v "${dst}:/dst:ro" --entrypoint sh "$VOLUME_COPY_IMAGE" -c 'find /dst -mindepth 1 -maxdepth 1 -print -quit')"
      if [ "$suffix" = db-data ]; then
        [ -n "$existing" ] || die "$EXIT_FAILED" "refusing to prune $v: matching replacement volume $dst ($suffix) is empty"
      elif [ -z "$existing" ]; then
        src_existing="$(docker run --rm --network none -v "${v}:/dst:ro" --entrypoint sh "$VOLUME_COPY_IMAGE" -c 'find /dst -mindepth 1 -maxdepth 1 -print -quit')"
        if [ -n "$src_existing" ]; then
          die "$EXIT_FAILED" "refusing to prune $v: source volume was non-empty but replacement volume $dst ($suffix) is empty"
        fi
      fi
    done
  fi

  # L1: When WAL archiving is active, refuse to prune without a verified healthy backup under stanza ludy.
  if [ -f "$DEPLOY_DIR/compose.wal.yml" ] || env_compose_file_lists compose.wal.yml; then
    [ "$ENV_FILE" = "$DEPLOY_DIR/.env" ] || die "$EXIT_USAGE" "prune-old-volumes with WAL requires --env-file to be $DEPLOY_DIR/.env (wal.sh reads LUDY_DIR/.env)"
    [ -n "$OVERLAY_DIR" ] && [ -f "$OVERLAY_DIR/backup/wal.sh" ] || die "$EXIT_USAGE" 'prune-old-volumes requires --overlay-dir with backup/wal.sh when compose.wal.yml is active'
    local stanza wal_info wal_backups
    stanza="$(env_last_value WAL_STANZA)"
    [ "$stanza" = ludy ] || die "$EXIT_FAILED" "refusing to prune: WAL_STANZA must be ludy before removing crove_* volumes (currently ${stanza:-crove})"
    wal_info="$(env -u WAL_STANZA -u BACKUP_S3_PREFIX -u WAL_DB_IMAGE -u COMPOSE_PROJECT_NAME \
      LUDY_DIR="$DEPLOY_DIR" CROVE_DIR="$DEPLOY_DIR" bash "$OVERLAY_DIR/backup/wal.sh" info)" || die "$EXIT_FAILED" 'wal.sh info failed on stanza ludy'
    printf '%s\n' "$wal_info" | grep -F 'stanza: ludy' >/dev/null || die "$EXIT_FAILED" 'refusing to prune: wal.sh info did not report stanza: ludy'
    printf '%s\n' "$wal_info" | grep -F 'status: ok' >/dev/null || die "$EXIT_FAILED" 'refusing to prune: stanza ludy status is not ok'
    wal_backups="$(printf '%s\n' "$wal_info" | grep -cE '(full|diff|incr) backup:' || true)"
    ((wal_backups > 0)) || die "$EXIT_FAILED" 'refusing to prune: no verified backup exists on stanza ludy yet'
    log "WAL backup gate passed (stanza=ludy status=ok backups=$wal_backups)"
  fi

  if ((${#old_vols[@]} > 0)); then
    log "removing old Docker volumes: ${old_vols[*]}"
    docker volume rm "${old_vols[@]}"
  else
    log 'no crove_* volumes left to remove'
  fi

  if docker image inspect crove-db:local >/dev/null 2>&1; then
    local used_by
    used_by="$(docker ps -a --filter ancestor=crove-db:local -q || true)"
    if [ -z "$used_by" ]; then
      log 'removing unused crove-db:local image'
      docker image rm crove-db:local || true
    fi
  fi

  # L2: Remove temporary unencrypted logical dumps once old volumes are safely pruned.
  local dump dumps_removed=0
  for dump in "$(state_dir)"/cutover-backup-*/db.dump; do
    [ -f "$dump" ] || continue
    rm -f "$dump"
    dumps_removed=$((dumps_removed + 1))
  done
  log "removed $dumps_removed temporary cutover db.dump file(s)"

  log 'prune-old-volumes SUCCEEDED'
}

do_rewrite_env_cmd() {
  (($# == 2)) || die "$EXIT_USAGE" 'usage: cutover-ludy.sh rewrite-env <input> <output>'
  rewrite_env_file "$1" "$2"
}

main() {
  local cmd="${1:-}"
  shift || true
  if [ "$cmd" = rewrite-env ]; then
    do_rewrite_env_cmd "$@"
    return 0
  fi
  while (($# > 0)); do
    parse_common_option "$@"
    ((OPT_SHIFT > 0)) || die "$EXIT_USAGE" "unknown option $1"
    shift "$OPT_SHIFT"
  done
  case "$cmd" in
    inspect) do_inspect ;;
    cutover-stack) do_cutover_stack ;;
    switch-wal) do_switch_wal ;;
    prune-old-volumes) do_prune_old_volumes ;;
    *) die "$EXIT_USAGE" 'usage: cutover-ludy.sh inspect|cutover-stack|switch-wal|prune-old-volumes|rewrite-env ...' ;;
  esac
}

main "$@"
