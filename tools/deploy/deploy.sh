#!/usr/bin/env bash
# Deploys a Crove release to a single docker compose host, and rolls it back (issue #56, docs/runbooks/deploy.md).
# Runs on the host. The deploy workflow (.github/workflows/deploy.yml) uploads it with the release's
# docker-compose.yml and runs it over SSH; it also installs itself as <dir>/.deploy/deploy.sh, so an operator can
# roll back from a shell on the host with one command.
#
#   deploy.sh deploy --release <id> --image <repo@sha256:...> --extract-image <repo@sha256:...>
#                    --media-image <repo@sha256:...> --compose <file>
#                    [--build <id>] [--auth-settings <file>] [--modules <list>] [--dir <dir>] [--env-file <file>]
#                    [--registry <host> --registry-user <user> --registry-password-stdin]
#   deploy.sh rollback [--dir <dir>] [--env-file <file>]
#   deploy.sh status   [--dir <dir>]
#   deploy.sh smoke <base url> [build id]
#   deploy.sh check-auth-settings <file>
#   deploy.sh check-modules <list>
#
# compose.pilot.yml (the pilot's split API and worker, #2133) is taken from the directory of the --compose file and
# staged with the release; the host chooses the layout by listing it in COMPOSE_FILE of the env file. A --compose file
# with no sibling falls back to the copy on the host, or stops before pulling when there is none.
#
# --auth-settings (#2704, "The pilot's identity provider settings" below): writes the pilot's remote identity provider settings
# into the env file, after a dated private copy of it, and puts that copy back when the deploy fails or the release is
# rolled back. --modules (#3531): writes CROVE_MODULES=<list> into the env file with the same single dated backup and
# rollback behavior (composing into one backup when both are given). Without them the env file is never edited (apart from
# the context token key).
#
# Smoke: the checks a user needs to sign in (health, readiness, config, Supabase Auth, the sign-in page), and, with
# SMOKE_EMAIL, SMOKE_PASSWORD and SMOKE_ORG set, an account step that signs in and uploads one synthetic e-invoice
# (see smoke_account). Without them it says the account step is skipped. With a build id (#892: the git SHA the image
# was built from, its CROVE_BUILD) it also checks that /version reports that build and no missing migration, so an
# old container that still answers fails the test. A deploy given --build checks the same, and so does a rollback to
# a release that was deployed with one; a release without a build id (deployed before /version) skips that step.
#
# Deploy: pull the three images by digest, start the database, make the context token key when the env file has none and
# count the plain idempotency rows (#3282), run `migrate`, start Supabase Auth and run `auth-grants`,
# start the other services, then the app: the worker before the API when they run as separate services (`worker`
# and `api`), else the all-in-one `crove` service. It waits for /readyz (every committed migration in the ledger,
# Supabase Auth grants in place) and runs the smoke test. When anything after the migration fails, it rolls back to
# the release that ran before and exits 1.
#
# Rollback restores images and compose files only. Migrations are forward only: the schema stays where the newer
# release left it, so every migration must keep the previous release working (expand, then contract in a later
# release; plan §3.5).
#
# Order of separate services (plan §3.5, #1965): toward a newer build the worker before the API, toward an older one
# the API before the worker, so a newer API does not serve beside an older worker (whose work it may not know; its
# /readyz answers 503 worker_build then, #1952). A build is older by the build time its image carries
# (CROVE_BUILD_TIME, the commit's date, recorded as BUILD_EPOCH in release.env), so a deploy of an older tag rolls the
# API first and the rollback from it the worker first; between releases without one (images from before #1952), by
# the time each was deployed (STAGED_AT).
#
# Exit codes: 0 done; 1 the deploy failed and the previous release runs again (or nothing was changed); 2 bad usage
# or configuration; 3 the deploy failed and so did the rollback: the instance needs an operator.
#
# Needs bash 4+, curl and docker with the compose plugin (v2.24 or newer, for `!reset`).
set -euo pipefail

readonly EXIT_FAILED=1 EXIT_USAGE=2 EXIT_ROLLBACK_FAILED=3

# Git Bash on Windows (the tests) rewrites arguments that look like paths; Linux ignores these.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# The env file is the one source of the context token key (#3282): a variable of the SSH session would win over the file in
# compose's interpolation, and `migrate` would install a key the file does not hold.
unset CROVE_CONTEXT_TOKEN_KEY

DEPLOY_DIR="${CROVE_DEPLOY_DIR:-/opt/crove}"
ENV_FILE="${CROVE_ENV_FILE:-}"
# Seconds: `docker compose up --wait` per step (Supabase Auth may migrate for minutes on an upgrade), /readyz, and
# how long a separate worker must stay running before the API is rolled.
WAIT_TIMEOUT="${CROVE_WAIT_TIMEOUT:-600}"
READY_TIMEOUT="${CROVE_READY_TIMEOUT:-300}"
WORKER_SETTLE="${CROVE_WORKER_SETTLE:-15}"
# Release directories kept on the host (the current and previous ones are never removed).
KEEP_RELEASES="${CROVE_KEEP_RELEASES:-5}"
# Dated copies of the env file kept next to it (the newest, and the one a rollback needs).
KEEP_ENV_BACKUPS="${CROVE_KEEP_ENV_BACKUPS:-5}"
# Base URL of the smoke test on the host; default: the loopback port the API service publishes.
SMOKE_URL="${CROVE_SMOKE_URL:-}"
# Seconds the account step of the smoke test waits for the worker to turn its upload into a proposal.
SMOKE_POLL_SECONDS="${CROVE_SMOKE_POLL_SECONDS:-120}"

# Output may go to an SSH session that has dropped (see the signal traps in main): a failed write never stops a
# deploy halfway.
log() { printf '[deploy] %s\n' "$*" 2>/dev/null || true; }
err() { printf '[deploy] ERROR: %s\n' "$*" >&2 2>/dev/null || true; }
die() {
  err "$2"
  exit "$1"
}

# A release id becomes a directory name and a log field: letters, digits, dot, dash and underscore only.
valid_release() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }
# An image pinned by digest: registry/name@sha256:<64 hex>, with an optional tag before the digest.
valid_image() { [[ "$1" =~ ^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$ ]]; }
# A build id (#892): the git SHA the image was built from, or another id of letters, digits, dot, dash and underscore.
valid_build() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; }
# An absolute path with no spaces or shell characters (it is written into generated files and the history log).
valid_path() { [[ "$1" =~ ^/[A-Za-z0-9._/@+-]*$ || "$1" =~ ^[A-Za-z]:/[A-Za-z0-9._/@+-]*$ ]]; }

# Available modules (must match AVAILABLE_MODULES in apps/kernel/src/config.ts).
AVAILABLE_MODULES=(kernel finance social ads crm notes hr meetings projects sign)
MODULES_RE='^[a-z][a-z0-9_]{0,31}(,[a-z][a-z0-9_]{0,31}){0,9}$'

# modules_validate <list>: checks a comma-separated list of 1 to 10 unique module names using shell builtins only.
modules_validate() {
  local LC_ALL=C raw="${1-}" rest item known seen='' avail
  if [ -z "$raw" ] || [ "${#raw}" -gt 330 ]; then
    err 'module list must be 1 to 10 comma-separated lowercase module names'
    return 1
  fi
  case "$raw" in
    *$'\n'* | *$'\r'* | ,* | *, | *,,*)
      err 'module list must be 1 to 10 comma-separated lowercase module names with no spaces, line breaks or empty entries'
      return 1
      ;;
  esac
  if [[ "$raw" =~ [[:space:]] ]] || [[ ! "$raw" =~ $MODULES_RE ]]; then
    err 'module list must be 1 to 10 comma-separated lowercase module names (no spaces, quotes or shell characters)'
    return 1
  fi
  rest="$raw"
  while :; do
    item="${rest%%,*}"
    known=0
    for avail in "${AVAILABLE_MODULES[@]}"; do
      if [ "$item" = "$avail" ]; then
        known=1
        break
      fi
    done
    if ((known == 0)); then
      err "unknown module '$item' (available: ${AVAILABLE_MODULES[*]})"
      return 1
    fi
    case ",$seen," in
      *",$item,"*)
        err "duplicate module '$item' in module list"
        return 1
        ;;
    esac
    seen+="${seen:+,}$item"
    [ "$rest" != "$item" ] || break
    rest="${rest#*,}"
  done
}

# ---------------------------------------------------------------------------------------------------------------
# Smoke test: what a user needs to sign in. Used on the host (loopback) and by the workflow (public URL).

# smoke_get <url>: prints the body; fails on a connection error, a timeout or a status of 400 or more.
smoke_get() { curl --silent --show-error --fail --location --max-time 15 "$1"; }

# smoke_body <url> <text>: the answer is a success and contains <text>.
smoke_body() {
  local body
  body="$(smoke_get "$1")" || return 1
  [[ "$body" == *"$2"* ]]
}

# The sign-in page: the app shell, and the first script bundle it loads.
smoke_login() {
  local base="$1" page asset
  page="$(smoke_get "$base/login")" || return 1
  [[ "$page" == *'id="root"'* ]] || return 1
  asset="$(grep -o 'src="/assets/[^"]*\.js"' <<<"$page" | head -n 1 | sed 's/^src="//; s/"$//')"
  [ -n "$asset" ] && smoke_get "$base$asset" >/dev/null
}

# The account step (#690): sign in with a password, upload one synthetic e-invoice into the smoke org, wait until the
# worker extracts it into a proposal, then reject that proposal so the smoke org's inbox stays empty. It runs only
# where SMOKE_EMAIL and SMOKE_PASSWORD are set: the workflow's public smoke test, from the environment's secrets
# (docs/runbooks/deploy.md, "Smoke account"). SMOKE_ORG is the smoke org's slug. Needs jq.
#
# Neither the password nor the access token is ever on a command line: the sign-in body is built by jq from the
# environment and piped to curl, and the token goes to curl in a header file only this user can read.

# The synthetic e-invoice: a fixed fake seller and buyer (tax codes that fail the checksum, so they belong to nobody)
# and a number from the clock, so each run files a new document instead of a duplicate of the last one.
smoke_invoice() {
  local number="$1" day="$2"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<HDon>
  <DLHDon Id="data">
    <TTChung>
      <PBan>2.1.0</PBan><THDon>HÓA ĐƠN GIÁ TRỊ GIA TĂNG</THDon><KHMSHDon>1</KHMSHDon><KHHDon>C26SMK</KHHDon>
      <SHDon>$number</SHDon><NLap>$day</NLap><DVTTe>VND</DVTTe><TGia>1</TGia><HTTToan>TM/CK</HTTToan>
    </TTChung>
    <NDHDon>
      <NBan><Ten>CÔNG TY KIỂM THỬ TRIỂN KHAI</Ten><MST>0101234564</MST><DChi>1 Đường Mẫu, Hà Nội</DChi></NBan>
      <NMua><Ten>TỔ CHỨC KIỂM THỬ CROVE</Ten><MST>0309876546</MST><DChi>2 Đường Thử, TP Hồ Chí Minh</DChi></NMua>
      <DSHHDVu>
        <HHDVu>
          <TChat>1</TChat><STT>1</STT><THHDVu>Kiểm thử sau triển khai</THHDVu><DVTinh>Lần</DVTinh>
          <SLuong>1</SLuong><DGia>100000</DGia><ThTien>100000</ThTien><TSuat>10%</TSuat>
        </HHDVu>
      </DSHHDVu>
      <TToan>
        <THTTLTSuat><LTSuat><TSuat>10%</TSuat><ThTien>100000</ThTien><TThue>10000</TThue></LTSuat></THTTLTSuat>
        <TgTCThue>100000</TgTCThue><TgTThue>10000</TgTThue><TgTTTBSo>110000</TgTTTBSo>
        <TgTTTBChu>Một trăm mười nghìn đồng</TgTTTBChu>
      </TToan>
    </NDHDon>
  </DLHDon>
</HDon>
EOF
}

# smoke_version <base> <build>: /version reports this build and no committed migration missing from the ledger.
smoke_version() {
  local body
  body="$(smoke_get "$1/version")" || return 1
  if [[ "$body" != *"\"build\":\"$2\""* || "$body" != *'"migrationsMissing":[]'* ]]; then
    err "smoke: expected build $2 with no missing migration; /version answered: ${body:0:500}"
    return 1
  fi
}

# smoke_api <headers file> <url> [curl args...]: like smoke_get, as the signed-in user, without following redirects.
smoke_api() {
  local headers="$1" url="$2"
  shift 2
  curl --silent --show-error --fail --max-time 30 --header "@$headers" "$@" "$url"
}

# smoke_rpc <headers file> <base> <procedure> [input json]: the web app's oRPC call, POST /api/rpc/<procedure>.
smoke_rpc() {
  local body='{}'
  if [ -n "${4:-}" ]; then body="{\"json\":$4}"; fi
  smoke_api "$1" "$2/api/rpc/$3" --request POST --header 'content-type: application/json' --data-binary "$body"
}

smoke_account() {
  local base="$1" work token headers number answer file_id status proposal error deadline rc=1
  command -v jq >/dev/null || {
    err 'the account step needs jq'
    return 1
  }
  # The password never travels in clear text.
  [[ "$base" == https://* || "$base" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] || {
    err 'the account step signs in only over https'
    return 1
  }
  [[ "${SMOKE_ORG:-}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || {
    err 'SMOKE_ORG must be the smoke org'"'"'s slug (lowercase letters, digits and dashes)'
    return 1
  }
  work="$(mktemp -d)" || return 1
  (
    umask 077
    headers="$work/headers"
    answer="$(jq -n '{email: env.SMOKE_EMAIL, password: env.SMOKE_PASSWORD}' |
      curl --silent --show-error --fail --max-time 15 --request POST --header 'content-type: application/json' \
        --data-binary @- "$base/auth/v1/token?grant_type=password")" || {
      err 'smoke: signing in with SMOKE_EMAIL and SMOKE_PASSWORD failed'
      exit 1
    }
    token="$(jq -r '.access_token // empty' <<<"$answer")"
    # A JWT: written into the header file below, so nothing else (no line break) may come with it.
    [[ "$token" =~ ^[A-Za-z0-9._-]+$ ]] || {
      err 'smoke: sign-in answered without an access token'
      exit 1
    }
    printf 'authorization: Bearer %s\nx-crove-org: %s\n' "$token" "$SMOKE_ORG" >"$headers"

    number="$(date -u +%s)"
    smoke_invoice "$number" "$(date -u +%F)" >"$work/crove-smoke-$number.xml"
    answer="$(smoke_api "$headers" "$base/api/files" --form "file=@$work/crove-smoke-$number.xml;type=application/xml")" || {
      err "smoke: uploading the synthetic e-invoice to org $SMOKE_ORG failed"
      exit 1
    }
    file_id="$(jq -r '.files[0].fileId // empty' <<<"$answer")"
    [ -n "$file_id" ] || {
      err 'smoke: the upload answered without a file id'
      exit 1
    }

    deadline=$((SECONDS + SMOKE_POLL_SECONDS))
    while :; do
      answer="$(smoke_rpc "$headers" "$base" files/recent)" || {
        err 'smoke: listing the recent files failed'
        exit 1
      }
      # One field per line, so an empty field stays empty (a whitespace IFS would merge it with the next one); line
      # breaks in the error text become spaces, so it stays one log line.
      {
        IFS= read -r status
        IFS= read -r proposal
        IFS= read -r error
      } < <(jq -r --arg id "$file_id" 'first(.json[]? | select(.id == $id)) // {} | (.status // ""), (.proposalId // ""), (.error // "" | gsub("[\r\n]"; " "))' <<<"$answer")
      if [ "$status" = proposed ] && [ -n "$proposal" ]; then break; fi
      if [ "$status" = failed ]; then
        err "smoke: the worker could not extract the synthetic e-invoice: $error"
        exit 1
      fi
      if ((SECONDS >= deadline)); then
        err "smoke: no proposal after ${SMOKE_POLL_SECONDS}s (file ${status:-not listed})"
        exit 1
      fi
      sleep 2
    done

    smoke_rpc "$headers" "$base" inbox/reject "$(jq -cn --arg id "$proposal" '{id: $id, reason: "Kiểm thử sau triển khai"}')" >/dev/null || {
      err "smoke: rejecting the smoke proposal $proposal failed"
      exit 1
    }
  ) && rc=0
  rm -rf "$work"
  return "$rc"
}

# Whether the env file says there is no bundled /auth/v1 proxy (#2704): AUTH_UPSTREAM_URL is set to empty (the last assignment counts).
# Only the host's own smoke test has an env file; the public one reads /api/config (smoke below).
smoke_env_has_no_proxy() {
  local v
  { [ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ]; } || return 1
  v="$(sed -n -E 's/\r$//; s/^[[:space:]]*(export[[:space:]]+)?AUTH_UPSTREAM_URL[[:space:]]*[=:][[:space:]]*(.*)$/v=\2/p' "$ENV_FILE" | tail -n 1)"
  [ -n "$v" ] || return 1
  v="${v#v=}"
  v="$(sed -E 's/^(""|'"''"')[[:space:]]*(#.*)?$//; s/[[:space:]]+#.*$//; s/[[:space:]]+$//' <<<"$v")"
  [ -z "$v" ]
}

# smoke_auth_url <base>: the authUrl /api/config of the running API reports (the address the app signs in at).
smoke_auth_url() {
  local body
  body="$(smoke_get "$1/api/config")" || return 1
  [[ "$body" =~ \"authUrl\":\"([^\"]*)\" ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}

# smoke_host <address>: its host and port, lower case, without the scheme, a default port or the path.
smoke_host() {
  local rest="${1#*://}"
  rest="${rest%%/*}"
  rest="${rest,,}"
  printf '%s' "${rest%:443}"
}

# The Auth URL the identity provider settings of this deploy name; set by do_deploy, or by the workflow's public smoke test through its
# environment (SMOKE_EXPECT_AUTH_URL). When set, /api/config must report exactly that address, so settings that did not take (an old
# container, a stale env line) fail the smoke test instead of passing on the proxy checks being skipped.
SMOKE_EXPECT_AUTH_URL="${SMOKE_EXPECT_AUTH_URL:-}"
# The module list configured for this deploy (#3531); set by do_deploy, or by the workflow's public smoke test through
# SMOKE_EXPECT_MODULES. When set, /api/config's "modules" JSON array must match {kernel} U <given modules>.
SMOKE_EXPECT_MODULES="${SMOKE_EXPECT_MODULES:-}"

_sort_join_items() {
  local LC_ALL=C i j tmp out=''
  local -a items=("$@")
  for ((i = 0; i < ${#items[@]}; i++)); do
    for ((j = i + 1; j < ${#items[@]}; j++)); do
      if [[ "${items[j]}" < "${items[i]}" ]]; then
        tmp="${items[i]}"
        items[i]="${items[j]}"
        items[j]="$tmp"
      fi
    done
  done
  for tmp in "${items[@]}"; do
    out+="${out:+,}$tmp"
  done
  printf '%s' "$out"
}

# smoke_modules <base> <expected csv>: /api/config reports "modules" matching {kernel} U <expected>. Pure bash + curl.
smoke_modules() {
  local LC_ALL=C base="$1" expect_raw="$2" body raw_arr rest item has_kernel=0 expected_joined actual_joined
  local -a expected_items=() actual_items=()
  local arr_re='(^|[,{])[[:space:]]*"modules"[[:space:]]*:[[:space:]]*\[([^]]*)\]'
  local item_re='^"([a-z][a-z0-9_]{0,31})"$'
  modules_validate "$expect_raw" || return 1
  rest="$expect_raw"
  while :; do
    item="${rest%%,*}"
    expected_items+=("$item")
    if [ "$item" = kernel ]; then has_kernel=1; fi
    [[ "$rest" == *,* ]] || break
    rest="${rest#*,}"
  done
  if ((has_kernel == 0)); then expected_items+=(kernel); fi
  expected_joined="$(_sort_join_items "${expected_items[@]}")"

  body="$(smoke_get "$base/api/config")" || return 1
  if [[ ! "$body" =~ $arr_re ]]; then
    err 'smoke: /api/config did not report a modules array'
    return 1
  fi
  raw_arr="${BASH_REMATCH[2]}"
  raw_arr="${raw_arr#"${raw_arr%%[![:space:]]*}"}"
  raw_arr="${raw_arr%"${raw_arr##*[![:space:]]}"}"
  if [ -z "$raw_arr" ]; then
    err "smoke: expected modules [$expected_joined] in /api/config; got [empty]"
    return 1
  fi
  case "$raw_arr" in
    ,* | *, | *,,*)
      err "smoke: /api/config reported malformed modules array"
      return 1
      ;;
  esac
  rest="$raw_arr"
  while :; do
    item="${rest%%,*}"
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    if [[ ! "$item" =~ $item_re ]]; then
      err "smoke: /api/config reported invalid module token in modules array"
      return 1
    fi
    actual_items+=("${BASH_REMATCH[1]}")
    [[ "$rest" == *,* ]] || break
    rest="${rest#*,}"
  done
  actual_joined="$(_sort_join_items "${actual_items[@]}")"
  if [ "$actual_joined" != "$expected_joined" ]; then
    err "smoke: expected modules [$expected_joined] in /api/config; got [$actual_joined]"
    return 1
  fi
}

# smoke <base url> [account] [build]: with "account" (the `smoke` command), the account step runs too when its settings
# are there. The deploy's own smoke test on the host never runs it: the workflow's public smoke test does, and a
# rollback must not depend on the smoke account, or a broken account would fail the rollback too. With a build id,
# /version must report it (#892).
smoke() {
  local base="${1%/}" account="${2:-}" build="${3:-}" failed=0 remote=0 auth_url=''
  smoke_check() {
    local name="$1"
    shift
    if "$@"; then log "smoke ok: $name"; else
      err "smoke failed: $name"
      failed=1
    fi
  }
  smoke_check '/healthz answers ok' smoke_body "$base/healthz" '"ok":true'
  # Every committed migration is in the ledger, and the session check can read Supabase Auth's tables.
  smoke_check '/readyz answers ready' smoke_body "$base/readyz" '"ready":true'
  if [ -n "$build" ]; then
    smoke_check "/version answers build $build with every migration applied" smoke_version "$base" "$build"
  fi
  smoke_check '/api/config answers' smoke_body "$base/api/config" '"authUrl"'
  # A remote identity provider has no /auth/v1 proxy here. The host's smoke test knows it from the env file; the public one (no env file)
  # from /api/config, whose authUrl is then not this API's own /auth/v1.
  auth_url="$(smoke_auth_url "$base" 2>/dev/null)" || auth_url=''
  if smoke_env_has_no_proxy; then remote=1
  elif [ -z "${ENV_FILE:-}" ] && [ -n "$auth_url" ] && [ "$auth_url" != "$base/auth/v1" ] && [ "$(smoke_host "$auth_url")" != "$(smoke_host "$base")" ] &&
    ! smoke_body "$base/auth/v1/health" 'GoTrue'; then
    # Another host, and no proxy answering here (the app's own page answers 200 to any GET: the answer must be GoTrue's): a remote identity provider. (The address only differing in case, scheme or a default port,
    # or a proxy that answers, is the bundled Auth as before.)
    remote=1
  fi
  if [ -n "$SMOKE_EXPECT_AUTH_URL" ]; then
    remote=1
    smoke_check '/api/config names the configured Auth URL (PUBLIC_AUTH_URL)' test "$auth_url" = "$SMOKE_EXPECT_AUTH_URL"
  fi
  if [ -n "$SMOKE_EXPECT_MODULES" ]; then
    smoke_check '/api/config lists the expected modules' smoke_modules "$base" "$SMOKE_EXPECT_MODULES"
  fi
  # Supabase Auth through the kernel's /auth/v1 proxy, the way signing in goes. A remote provider has no proxy here.
  if ((remote)); then
    log 'smoke skipped: /auth/v1/health (Supabase Auth is a remote provider; the prober watches it)'
  else
    smoke_check '/auth/v1/health answers (Supabase Auth through the proxy)' smoke_body "$base/auth/v1/health" ''
  fi
  smoke_check '/login loads the app shell and its script bundle' smoke_login "$base"
  if [ "$account" = account ] && ((remote)); then
    log 'smoke skipped: sign-in and upload (the smoke account signs in through the proxy, which a remote provider does not have)'
  elif [ "$account" = account ]; then
    if [ -n "${SMOKE_EMAIL:-}" ] && [ -n "${SMOKE_PASSWORD:-}" ]; then
      smoke_check "signs in, uploads a synthetic e-invoice to org ${SMOKE_ORG:-?} and gets a proposal" smoke_account "$base"
    else
      log 'smoke skipped: sign-in and upload (SMOKE_EMAIL and SMOKE_PASSWORD are not set)'
    fi
  fi
  return "$failed"
}

# ---------------------------------------------------------------------------------------------------------------
# State on the host, under $DEPLOY_DIR:
#   .env                         the instance's settings and secrets (owner managed; or --env-file)
#   compose.host.yml             optional owner managed override (reverse proxy, split roles, profiles)
#   compose.pilot.yml            the split API and worker with the finance module only (tools/deploy/compose.pilot.yml), copied
#                                from the active release when the env file's COMPOSE_FILE lists it; unused otherwise
#   docker-compose.yml           the running release's compose file
#   docker-compose.override.yml  the running release's image pins (generated), so plain `docker compose` in this
#                                directory (and tools/backup) sees the same stack
#   releases/<id>-<digest12>/    each deployed release: docker-compose.yml, docker-compose.override.yml, release.env
#   .deploy/current, previous    the release directory names that run now and ran before
#   .deploy/history.log          one line per deploy and rollback
#   .deploy/deploy.sh            this script, for a manual rollback

state_dir() { printf '%s/.deploy' "$DEPLOY_DIR"; }
read_state() { if [ -f "$(state_dir)/$1" ]; then cat "$(state_dir)/$1"; fi; }
write_state() { printf '%s\n' "$2" >"$(state_dir)/$1.tmp" && mv -f "$(state_dir)/$1.tmp" "$(state_dir)/$1"; }
record() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$(state_dir)/history.log"; }

LOCK_HELD=0
acquire_lock() {
  local lock pid
  lock="$(state_dir)/lock"
  if ! mkdir "$lock" 2>/dev/null; then
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then die "$EXIT_USAGE" "another deploy (pid $pid) is running"; fi
    # No pid yet: another run may have just taken the lock. Only a lock older than a minute is stale.
    if [ -z "$pid" ] && [ -z "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      die "$EXIT_USAGE" 'another deploy is starting'
    fi
    log "removing a stale lock left by pid ${pid:-unknown}"
    rm -rf "$lock"
    mkdir "$lock" || die "$EXIT_USAGE" "cannot take the lock $lock"
  fi
  printf '%s\n' "$$" >"$lock/pid"
  LOCK_HELD=1
}
release_lock() { if [ "$LOCK_HELD" = 1 ]; then rm -rf "$(state_dir)/lock"; fi; }

# The registry login's throwaway Docker config (pull_images); removed on every exit.
PULL_CONFIG=''
cleanup() {
  if [ -n "$PULL_CONFIG" ]; then rm -rf "$PULL_CONFIG"; fi
  # The copies of the env file made while the context token key is written hold that key (and the old file). Stopped while
  # the env file itself is being overwritten, they are the way back: kept, and named.
  if [ "${KEY_WRITING:-0}" = 1 ]; then
    err "stopped while writing the context token key into $ENV_FILE: the file may be incomplete. The old file is at ${KEY_BAK:-?} and the new one at ${KEY_TMP:-?} (both mode 600): copy the old one over $ENV_FILE and delete both"
  else
    if [ -n "${KEY_TMP:-}" ]; then rm -f "$KEY_TMP"; fi
    if [ -n "${KEY_BAK:-}" ]; then rm -f "$KEY_BAK"; fi
  fi
  # The new env file of the deploy settings holds them. Stopped while the env file itself is being overwritten, the
  # dated copy is the way back: kept, and named.
  if [ "${ENV_WRITING:-0}" = 1 ]; then
    err "stopped while writing ${ENV_CHANGE_LABEL:-the settings} into $ENV_FILE: the file may be incomplete. The old file is at ${ENV_BACKUP:-?} (mode 600): copy it over $ENV_FILE"
  fi
  if [ -n "${ENV_TMP:-}" ]; then rm -f "$ENV_TMP"; fi
  release_lock
}

# What runs in a deploy or rollback, for the history log when it is stopped.
CURRENT_WORK=''
on_signal() {
  record "${CURRENT_WORK:-run} interrupted by a signal; check the stack (deploy.sh status, docker compose ps)$([ "${ENV_CHANGED:-0}" = 1 ] && echo "; the env file was replaced, the dated copy is $ENV_BACKUP")"
  err 'interrupted; the stack may be half rolled'
  exit 143
}

# Called once the lock is held. A dropped SSH session (a cancelled job, a network blip) must not stop a deploy
# halfway: hangups and writes to the closed connection are ignored, and the run finishes and records its result.
# An explicit stop (TERM, INT) is recorded in the history log.
guard_run() {
  CURRENT_WORK="$1"
  trap cleanup EXIT
  trap '' HUP PIPE
  trap on_signal TERM INT
}

# docker compose for the active files in $DEPLOY_DIR. The project name comes from the compose file (`crove`) or
# COMPOSE_PROJECT_NAME in the env file, so volumes stay the same from release to release.
DC_PREFIX=()
dc() {
  local args=(compose --project-directory "$DEPLOY_DIR" --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml")
  # The pilot's split API and worker (tools/deploy/compose.pilot.yml, #2118) right after the release's file: they extend its
  # `crove` service, whose image the release's pins (next) must then replace. The host chooses the layout by listing the file
  # in COMPOSE_FILE (#2133); the file itself comes with each release (activate), so it stays in step with docker-compose.yml.
  if pilot_layout && [ -f "$DEPLOY_DIR/compose.pilot.yml" ]; then args+=(-f "$DEPLOY_DIR/compose.pilot.yml"); fi
  args+=(-f "$DEPLOY_DIR/docker-compose.override.yml")
  # The database image with pgBackRest and the bucket's settings (tools/backup/compose.wal.yml, #2120). The image
  # (crove-db:local, built from tools/wal) is on the host, never pulled: a deploy starts `db` with --no-build.
  if [ -f "$DEPLOY_DIR/compose.wal.yml" ]; then args+=(-f "$DEPLOY_DIR/compose.wal.yml"); fi
  if [ -f "$DEPLOY_DIR/compose.host.yml" ]; then args+=(-f "$DEPLOY_DIR/compose.host.yml"); fi
  # DC_PREFIX: a command to run docker under (the count of plain idempotency rows runs under `timeout`).
  ${DC_PREFIX[@]+"${DC_PREFIX[@]}"} docker "${args[@]}" "$@"
}

# Image pins of a release. The images are exported too, so compose.host.yml can use ${CROVE_IMAGE} for services it
# adds (`api` and `worker` with split roles).
write_override() {
  local image="$1" extract="$2" media="$3"
  cat <<EOF
# Generated by tools/deploy/deploy.sh: the release's images by digest. Do not edit; put local changes in
# compose.host.yml.
services:
  migrate: { image: '$image', build: !reset null }
  auth-grants: { image: '$image', build: !reset null }
  crove: { image: '$image', build: !reset null }
  prober: { image: '$image', build: !reset null }
  usage: { image: '$image', build: !reset null }
  crove-extract: { image: '$extract', build: !reset null }
  crove-media: { image: '$media', build: !reset null }
EOF
}

# Whether the host runs the pilot's split API and worker: its env file lists compose.pilot.yml in COMPOSE_FILE (the same
# line `pnpm pilot:check` reads). Read each time, so taking the file out of COMPOSE_FILE is all it takes to go back to one
# container (#2133).
pilot_layout() {
  env_compose_file_lists compose.pilot.yml
}

# Whether the env file's COMPOSE_FILE names a compose file (the name is matched literally). The last assignment wins, as in a dotenv
# file: `export` and spaces around `=` are allowed, a trailing ` # comment` is not part of the value, and a commented-out line is not
# an assignment. The one reading of that line, for the pilot layout and for the WAL overlay (#2162).
env_compose_file_lists() {
  sed -n -E 's/\r$//; s/^[[:space:]]*(export[[:space:]]+)?COMPOSE_FILE[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" \
    | tail -n 1 | sed -E 's/[[:space:]]+#.*$//' | grep -q -F -- "$1"
}

# In the pilot layout, the same image pins for `api` and `worker`, so a plain `docker compose` in the stack directory
# (tools/backup/restore.sh, a manual `up`) runs the release's digest, not crove:local. Only in that layout: an `api` service
# defined by a pin alone would run the all-in-one role with no settings, and `has_service` would roll it.
pilot_pins() {
  pilot_layout || return 0
  printf "  api: { image: '%s', build: !reset null }\n  worker: { image: '%s', build: !reset null }\n" "$1" "$1"
}

# Whether the host's compose.pilot.yml is, byte for byte, the copy of a release staged on this host (an earlier deploy put it there).
host_pilot_file_is_a_release_copy() {
  local f
  for f in "$DEPLOY_DIR"/releases/*/compose.pilot.yml; do
    if [ -f "$f" ] && cmp -s "$f" "$DEPLOY_DIR/compose.pilot.yml"; then return 0; fi
  done
  return 1
}

# Makes a release directory the active files and exports its images.
ACTIVE_BUILD=''
activate() {
  local rel="$DEPLOY_DIR/releases/$1"
  [ -f "$rel/release.env" ] || die "$EXIT_USAGE" "release directory $rel is incomplete"
  rm -f "$DEPLOY_DIR/compose.pilot.yml.tmp"
  cp -f "$rel/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml.tmp"
  cp -f "$rel/docker-compose.override.yml" "$DEPLOY_DIR/docker-compose.override.yml.tmp"
  CROVE_IMAGE="$(release_field "$1" IMAGE)"
  CROVE_EXTRACT_IMAGE="$(release_field "$1" EXTRACT_IMAGE)"
  # Empty for a release staged before crove-media was published (a rollback to it): nothing is pulled for it and its override pins none; its
  # own compose files decide whether crove-media runs (a release from before #2988 keeps it behind the `media` profile).
  CROVE_MEDIA_IMAGE="$(release_field "$1" MEDIA_IMAGE)"
  # The pins of `api` and `worker` follow the layout of now, whatever the release was staged under: taken out of a release
  # staged in the pilot layout when the host has gone back to one container (they would define bare services), put in
  # one staged before (#2133).
  { grep -v -E "^  (api|worker): \{ image:" "$DEPLOY_DIR/docker-compose.override.yml.tmp" || true; } >"$DEPLOY_DIR/docker-compose.override.yml.pins"
  mv -f "$DEPLOY_DIR/docker-compose.override.yml.pins" "$DEPLOY_DIR/docker-compose.override.yml.tmp"
  pilot_pins "$CROVE_IMAGE" >>"$DEPLOY_DIR/docker-compose.override.yml.tmp"
  # The pilot file ships with the release. A release staged before that (a rollback to it) keeps the host's copy.
  if pilot_layout; then
    if [ -f "$rel/compose.pilot.yml" ]; then
      # The release's copy replaces the host's. Say so when the host's matches no release this host staged, that is when it was edited by hand
      # (#2162); the line names the file, never its content. The host's copy of an earlier release, or of one a failed deploy left, is no edit.
      if [ -f "$DEPLOY_DIR/compose.pilot.yml" ] && ! host_pilot_file_is_a_release_copy; then
        log "replacing $DEPLOY_DIR/compose.pilot.yml with the copy of release $1: the host's copy matches no staged release, so it was edited by hand and that edit is lost (keep host settings in compose.host.yml)"
      fi
      cp -f "$rel/compose.pilot.yml" "$DEPLOY_DIR/compose.pilot.yml.tmp"
    elif [ ! -f "$DEPLOY_DIR/compose.pilot.yml" ]; then
      die "$EXIT_USAGE" "COMPOSE_FILE in $ENV_FILE lists compose.pilot.yml but release $1 does not carry it and $DEPLOY_DIR has none (docs/runbooks/deploy.md, \"The pilot layout\")"
    fi
  fi
  # The three files are moved in a row, so a plain `docker compose` (the backup cron) sees them together as nearly as it can.
  if [ -f "$DEPLOY_DIR/compose.pilot.yml.tmp" ]; then mv -f "$DEPLOY_DIR/compose.pilot.yml.tmp" "$DEPLOY_DIR/compose.pilot.yml"; fi
  mv -f "$DEPLOY_DIR/docker-compose.yml.tmp" "$DEPLOY_DIR/docker-compose.yml"
  mv -f "$DEPLOY_DIR/docker-compose.override.yml.tmp" "$DEPLOY_DIR/docker-compose.override.yml"
  export CROVE_IMAGE CROVE_EXTRACT_IMAGE CROVE_MEDIA_IMAGE
  # The build the release's image reports on /version; empty for a release deployed without --build.
  ACTIVE_BUILD="$(release_field "$1" BUILD)"
}

release_field() { sed -n "s/^$2=//p" "$DEPLOY_DIR/releases/$1/release.env" | head -n 1; }

# Services by role, from the active files and the profiles enabled in the env file (COMPOSE_PROFILES).
SERVICES=()
load_services() {
  local out
  out="$(dc config --services)" || return 1
  mapfile -t SERVICES <<<"$out"
}
has_service() {
  local s
  for s in "${SERVICES[@]}"; do [ "$s" = "$1" ] && return 0; done
  return 1
}
# One-shot jobs and the app are rolled by name; everything else (Supabase Auth, crove-extract, a reverse proxy from
# compose.host.yml) is infrastructure and starts before the app. The prober starts last.
infra_services() {
  local s
  for s in "${SERVICES[@]}"; do
    case "$s" in db | migrate | auth-grants | usage | crove | api | worker | prober | '') ;; *) printf '%s\n' "$s" ;; esac
  done
}

# The app's HTTP service and the loopback URL the smoke test uses.
api_service() { if has_service api; then echo api; else echo crove; fi; }
local_url() {
  local mapped port
  if [ -n "$SMOKE_URL" ]; then
    echo "${SMOKE_URL%/}"
    return
  fi
  mapped="$(dc port "$(api_service)" 8080 | head -n 1)" || return 1
  port="${mapped##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  echo "http://127.0.0.1:$port"
}

# Asks at least once before it looks at the clock: SECONDS counts whole seconds, so with a short timeout the deadline
# can pass before the first question, and an instance that is ready would be taken for one that never got ready (#1841).
wait_ready() {
  local url="$1" deadline=$((SECONDS + READY_TIMEOUT))
  log "waiting for $url/readyz (up to ${READY_TIMEOUT}s)"
  while :; do
    if smoke_body "$url/readyz" '"ready":true' 2>/dev/null; then
      log 'ready: every committed migration is applied'
      return 0
    fi
    ((SECONDS < deadline)) || break
    sleep 3
  done
  err "not ready after ${READY_TIMEOUT}s: $(curl --silent --max-time 5 "$url/readyz" 2>/dev/null || echo 'no answer')"
  return 1
}

up() { dc up --detach --no-build --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" "$@"; }

# The build time an image carries (CROVE_BUILD_TIME, #1952), in seconds since the epoch; nothing when it has none or
# the image is not on the host.
image_build_epoch() {
  local t
  t="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n 's/^CROVE_BUILD_TIME=//p' | head -n 1)" || true
  [ -n "$t" ] || return 0
  date -u -d "$t" +%s 2>/dev/null || true
}

# direction_to <release> <from release>: forward when the release's build is not older than the one it replaces, back
# when it is. By BUILD_EPOCH when both have one, else by STAGED_AT; forward when nothing runs.
direction_to() {
  local to="$1" from="$2" a b
  if [ -z "$from" ]; then
    echo forward
    return
  fi
  a="$(release_field "$to" BUILD_EPOCH)"
  b="$(release_field "$from" BUILD_EPOCH)"
  if [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[0-9]+$ ]]; then
    if ((a < b)); then echo back; else echo forward; fi
    return
  fi
  if [[ "$(release_field "$to" STAGED_AT)" < "$(release_field "$from" STAGED_AT)" ]]; then echo back; else echo forward; fi
}

# Whether the env file assigns a non-empty AUTH_ALLOWED_EMAILS (names a setting only; nothing of the file is printed).
env_lists_allowed_emails() {
  [ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ] || return 1
  grep -q -E '^[[:space:]]*(export[[:space:]]+)?AUTH_ALLOWED_EMAILS[[:space:]]*[=:][[:space:]]*[^[:space:]#]' "$ENV_FILE"
}

# Rolls the worker of the active release when it runs as its own service, and checks it stays up.
roll_worker() {
  log 'rolling the worker'
  dc up --detach --no-build --no-deps worker || return 1
  sleep "$WORKER_SETTLE"
  if ! dc ps --status running --services | grep -qx worker; then
    err 'the worker is not running'
    # Not while the env file lists who may sign in: a worker that refuses a bad entry names it in its log, and this output may be a public
    # CI log (a secret is masked there only as a whole). The names are enough to find it on the host.
    if env_lists_allowed_emails; then
      err 'the worker log is not shown here because the env file sets AUTH_ALLOWED_EMAILS (read it on the host: docker compose logs worker)'
    else
      dc logs --tail 50 worker >&2 || true
    fi
    return 1
  fi
}

# roll_services [forward|back]: rolls the active release's services. The database and the migration are deploy only
# (step "migrate" in do_deploy); a rollback starts here with the older release's files. forward (toward a newer build,
# the default) rolls a separate worker before the API, back (toward an older one) the API before the worker (see the
# header and direction_to).
roll_services() {
  local direction="${1:-forward}" infra=() rest=() url s
  load_services || return 1
  mapfile -t infra < <(infra_services)
  if has_service auth; then
    log 'starting Supabase Auth (it migrates its own schema before it is healthy)'
    up auth || return 1
  fi
  if has_service auth-grants; then
    log 'running auth-grants'
    dc run --rm --no-TTY --no-deps auth-grants || return 1
  fi
  for s in "${infra[@]}"; do if [ "$s" != auth ]; then rest+=("$s"); fi; done
  if ((${#rest[@]} > 0)); then
    log "starting ${rest[*]}"
    up "${rest[@]}" || return 1
  fi
  if has_service worker && has_service api; then
    # The first deploy of the pilot layout on a host that ran the all-in-one `crove`: that container would keep the API's
    # port and run the worker's jobs beside the new one (#2118). Nothing to remove on a later deploy.
    local removed
    if ! removed="$(dc rm --stop --force crove 2>&1)"; then log "could not remove the old crove container (the deploy goes on): ${removed:0:300}"; fi
    if [ "$direction" = back ]; then
      log 'rolling the API (toward an older build: the API before the worker)'
      up api || return 1
      roll_worker || return 1
    else
      roll_worker || return 1
      log 'rolling the API'
      up api || return 1
    fi
  else
    log 'rolling crove (api and worker in one container)'
    up crove || return 1
  fi
  url="$(local_url)" || {
    err 'cannot find the API port'
    return 1
  }
  wait_ready "$url" || return 1
  if has_service prober; then up prober || return 1; fi
  log "smoke test on $url"
  smoke "$url" '' "$ACTIVE_BUILD"
}

pull_images() {
  local image="$1" extract="$2" media="$3" registry="$4" user="$5" password="$6" rc=0
  # A throwaway Docker config for the registry login, removed right after the pull (and by cleanup on any exit): no
  # credential stays on the host. Only the plain `docker pull` uses it (compose may live in the default config's
  # cli-plugins).
  PULL_CONFIG="$(mktemp -d)"
  if [ -n "$password" ]; then
    printf '%s' "$password" | DOCKER_CONFIG="$PULL_CONFIG" docker login --username "$user" --password-stdin "$registry" >/dev/null || rc=$?
  fi
  if [ "$rc" = 0 ]; then
    log "pulling $image"
    DOCKER_CONFIG="$PULL_CONFIG" docker pull --quiet "$image" >/dev/null || rc=$?
  fi
  if [ "$rc" = 0 ]; then
    log "pulling $extract"
    DOCKER_CONFIG="$PULL_CONFIG" docker pull --quiet "$extract" >/dev/null || rc=$?
  fi
  # A release staged before crove-media was published has no media image to pull (a rollback to it).
  if [ "$rc" = 0 ] && [ -n "$media" ]; then
    log "pulling $media"
    DOCKER_CONFIG="$PULL_CONFIG" docker pull --quiet "$media" >/dev/null || rc=$?
  fi
  rm -rf "$PULL_CONFIG"
  PULL_CONFIG=''
  return "$rc"
}

compose_version_ok() {
  local v major minor
  v="$(docker compose version --short 2>/dev/null)" || return 1
  v="${v#v}"
  major="${v%%.*}"
  minor="${v#*.}"
  minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  ((major > 2 || (major == 2 && minor >= 24)))
}

preflight() {
  valid_path "$DEPLOY_DIR" || die "$EXIT_USAGE" "--dir must be an absolute path without spaces: $DEPLOY_DIR"
  [ -n "$ENV_FILE" ] || ENV_FILE="$DEPLOY_DIR/.env"
  valid_path "$ENV_FILE" || die "$EXIT_USAGE" "--env-file must be an absolute path without spaces: $ENV_FILE"
  [ -f "$ENV_FILE" ] || die "$EXIT_USAGE" "env file $ENV_FILE not found (copy .env.example there and change every secret)"
  # The WAL archiving overlay (#2120) stays the host's own file: without it the deploy would recreate `db` on the plain PostgreSQL image,
  # while the volume still tells PostgreSQL to push every WAL segment with a command that image does not have.
  if env_compose_file_lists compose.wal.yml && [ ! -f "$DEPLOY_DIR/compose.wal.yml" ]; then
    die "$EXIT_USAGE" "COMPOSE_FILE in $ENV_FILE lists compose.wal.yml but $DEPLOY_DIR/compose.wal.yml does not exist: copy tools/backup/compose.wal.yml there (docs/runbooks/backup-and-restore.md, \"Point in time recovery\")"
  fi
  command -v docker >/dev/null || die "$EXIT_USAGE" 'docker is not installed'
  command -v curl >/dev/null || die "$EXIT_USAGE" 'curl is not installed'
  compose_version_ok || die "$EXIT_USAGE" 'docker compose v2.24 or newer is required'
  mkdir -p "$(state_dir)" "$DEPLOY_DIR/releases"
}

# ---------------------------------------------------------------------------------------------------------------
# Production steps of a deploy (#3282, docs/runbooks/deploy.md, "Steps for the context token key and plain
# idempotency rows"). They run on the host, after the database is up and before `migrate`, so the key never leaves it.

# The line numbers of the last CROVE_CONTEXT_TOKEN_KEY assignment in the env file, and whether its value is set. Read like a
# dotenv file, the last assignment wins: `export` and spaces around `=` (or `:`, which the dotenv parser of compose accepts too) are allowed, a ` # comment` is not part of the value, `""` and
# `''` are empty, and a commented-out line is not an assignment. When a value is in doubt (`KEY=#x`) it counts as set: a key that
# is there is never replaced, and a deploy that wrongly takes a key for missing would destroy one.
# Sets KEY_LINE (0: no assignment) and KEY_SET (1: the effective value is not empty). Builtins only: the value is never
# an argument or an environment variable of another process, and it is never printed.
KEY_LINE=0 KEY_SET=0
env_key_scan() {
  local file="${1:-$ENV_FILE}" line raw value n=0
  KEY_LINE=0 KEY_SET=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?CROVE_CONTEXT_TOKEN_KEY[[:space:]]*[=:](.*)$ ]]; then
      KEY_LINE=$n
      raw="${BASH_REMATCH[2]}"
      value="$raw"
      if [[ "$raw" =~ ^[[:space:]]+# ]]; then
        value=''
      else
        value="${value#"${value%%[![:space:]]*}"}"
        # Empty quotes end the value, whatever follows them (a comment); else a comment starts at the first ` #`.
        if [[ "$value" =~ ^(\"\"|\'\')[[:space:]]*(#.*)?$ ]]; then
          value=''
        else
          value="${value%%[[:space:]]#*}"
          value="${value%"${value##*[![:space:]]}"}"
        fi
      fi
      if [ -n "$value" ]; then KEY_SET=1; else KEY_SET=0; fi
    fi
  done <"$file"
}

# Before anything changes: when the env file has no context token key, the deploy must be able to make one.
context_token_key_preflight() {
  env_key_scan
  ((KEY_SET)) && return 0
  command -v openssl >/dev/null || die "$EXIT_USAGE" "$ENV_FILE has no CROVE_CONTEXT_TOKEN_KEY and openssl is not installed to make one (docs/runbooks/context-token-key.md)"
  [ -w "$ENV_FILE" ] || die "$EXIT_USAGE" "$ENV_FILE has no CROVE_CONTEXT_TOKEN_KEY and the deploy user cannot write to the file (docs/runbooks/context-token-key.md)"
}

# The temporary files while the key is written: the new env file (it holds the key) and a copy of the old one. Removed on
# every exit, except while the env file itself is being overwritten (KEY_WRITING=1): a stop then keeps both and names them.
KEY_TMP='' KEY_BAK='' KEY_WRITING=0

# ensure_context_token_key: when the env file has no context token key, makes one with `openssl rand -base64 32` and writes it
# into the file (#1822, docs/runbooks/context-token-key.md section 1); an existing key is never replaced, rotation stays a
# manual step. The key is never printed, logged, passed as an argument or exported: it lives in one shell variable, goes to
# a 0600 copy of the file by `printf` (a builtin) and from there into the file with `cat >`, which keeps the file's inode,
# owner and mode. The new copy is checked before the file is touched (every line of the old file, the key line, nothing
# cut short by a full disk), and the old file is kept in a second 0600 copy so a failed or interrupted overwrite is put
# back. The log says only `context token key generated` or `present`. Returns 1 when the key could not be written.
ensure_context_token_key() {
  # Never traced: a `set -x` of a caller would print the key.
  { set +x; } 2>/dev/null
  local key line n=0 cr='' lines bad=0
  env_key_scan
  if ((KEY_SET)); then
    log 'context token key present'
    return 0
  fi
  KEY_TMP="$(mktemp "$(state_dir)/env-key.XXXXXX")" || {
    err 'cannot make a temporary file for the context token key'
    KEY_TMP=''
    return 1
  }
  KEY_BAK="$(mktemp "$(state_dir)/env-old.XXXXXX")" || {
    err 'cannot make a temporary file for the context token key'
    KEY_BAK=''
    return 1
  }
  key="$(openssl rand -base64 32 </dev/null)" || key=''
  # 32 bytes in base64: 43 characters and one `=`.
  if [[ ! "$key" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
    err 'openssl did not make a 32 byte key'
    key=''
    return 1
  fi
  {
    while IFS= read -r line || [ -n "$line" ]; do
      n=$((n + 1))
      if [ "$n" = "$KEY_LINE" ]; then
        # Keep a line break of CRLF as it was; the replaced line loses `export`, which compose does not need.
        if [ "${line: -1}" = $'\r' ]; then cr=$'\r'; fi
        printf 'CROVE_CONTEXT_TOKEN_KEY=%s%s\n' "$key" "$cr" || bad=1
      else
        printf '%s\n' "$line" || bad=1
      fi
    done <"$ENV_FILE"
    if [ "$KEY_LINE" = 0 ]; then printf 'CROVE_CONTEXT_TOKEN_KEY=%s\n' "$key" || bad=1; fi
  } >"$KEY_TMP" || bad=1
  if ((bad)); then
    err 'writing the new env file failed (is the disk full?); the env file was not touched'
    key=''
    return 1
  fi
  key=''
  # The new copy must hold every line of the old file (and the key line, added if there was none) and the key.
  lines=$(($(wc -l <"$KEY_TMP")))
  if [ "$KEY_LINE" = 0 ]; then n=$((n + 1)); fi
  env_key_scan "$KEY_TMP"
  if [ "$lines" != "$n" ] || ((KEY_SET == 0)); then
    err 'the new env file is incomplete (is the disk full?); the env file was not touched'
    return 1
  fi
  if ! { cat "$ENV_FILE" >"$KEY_BAK" && cmp -s "$ENV_FILE" "$KEY_BAK"; }; then
    err 'cannot keep a copy of the env file; the env file was not touched'
    return 1
  fi
  # Into the file itself, not a rename: the owner, the mode and the inode of the env file stay. A write that fails or is
  # cut off is put back from the old copy; if that fails too, both copies are kept and named.
  KEY_WRITING=1
  if ! { cat "$KEY_TMP" >"$ENV_FILE" && cmp -s "$KEY_TMP" "$ENV_FILE"; }; then
    if { cat "$KEY_BAK" >"$ENV_FILE" && cmp -s "$KEY_BAK" "$ENV_FILE"; }; then
      KEY_WRITING=0
      err "writing the context token key into $ENV_FILE failed; the file was put back as it was"
    else
      err "writing the context token key into $ENV_FILE failed and so did putting it back: the file may be incomplete. The old file is at $KEY_BAK and the new one at $KEY_TMP (both mode 600): copy the old one over $ENV_FILE and delete both"
      # Kept for the operator: the cleanup must not remove them, nor name them again with no path.
      KEY_TMP='' KEY_BAK='' KEY_WRITING=0
    fi
    return 1
  fi
  KEY_WRITING=0
  rm -f "$KEY_TMP" "$KEY_BAK"
  KEY_TMP='' KEY_BAK=''
  env_key_scan
  ((KEY_SET)) || {
    err "the context token key is not in $ENV_FILE after writing it"
    return 1
  }
  log 'context token key generated'
  log "person step: copy CROVE_CONTEXT_TOKEN_KEY from $ENV_FILE on the host into the secret store (open the file in an editor; never print it into a shared log), docs/runbooks/context-token-key.md"
  record 'context token key generated' || true
}

# count_plain_idempotency_rows: the read-only count of idempotency rows that still hold a plain SHA-256 (#1750 step 2 may not
# merge while there are any): the query as the superuser inside the database container (the table is under row-level
# security, so only a role that bypasses it counts every org), in a session that is read only and times out. It writes
# `plain idempotency rows: <n>` to the log and never fails the deploy: a count that did not run says so and the deploy goes on.
PLAIN_IDEMPOTENCY_SQL="SELECT count(*) FROM crove_kernel.idempotency_key WHERE NOT starts_with(request_sha256, 'k1:')"
count_plain_idempotency_rows() {
  local n='' why='' errfile
  errfile="$(mktemp "$(state_dir)/count-err.XXXXXX" 2>/dev/null)" || errfile=/dev/null
  # A wall-clock bound besides the session's timeouts, where `timeout` exists: a stuck `docker compose exec` ends as a count that did not run.
  DC_PREFIX=()
  if command -v timeout >/dev/null; then DC_PREFIX=(timeout -k 5 60); fi
  if n="$(dc exec -T -e 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000' db \
    psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$PLAIN_IDEMPOTENCY_SQL" 2>"$errfile" </dev/null)" && [[ "$n" =~ ^[0-9]+$ ]]; then
    log "plain idempotency rows: $n"
  else
    why="$(head -c 300 "$errfile" 2>/dev/null | tr '\r\n' '  ')" || why=''
    log "plain idempotency rows: unknown (the count did not run; the deploy goes on): ${why:-no answer}"
  fi
  DC_PREFIX=()
  if [ "$errfile" != /dev/null ]; then rm -f "$errfile"; fi
  return 0
}

# ---------------------------------------------------------------------------------------------------------------
# The pilot's identity provider settings (#2704, docs/runbooks/pilot-sign-in-remote-idp.md, steps 1 and 5). Opt-in: a deploy
# given --auth-settings <file> writes exactly those lines into the host's env file, so no one needs a shell on the host. The
# workflow builds the file from the GitHub environment's variables and secret and uploads it with the release; this script
# checks it again (it is the one that edits the host). Without the option nothing here runs.
#
# The file holds NAME=value lines, no quotes, one per name, from AUTH_SETTING_NAMES. Every value is checked against a short
# allow-list of characters, so a value can neither start another line nor reach a shell, compose's interpolation or a
# comment; a value that fails is named in the error, never shown. What goes into the env file: the lines of the file that have
# a value, AUTH_SESSION_CHECK=jwt and an empty AUTH_UPSTREAM_URL (no bundled proxy). What leaves it: every assignment of
# those names and of AUTH_SIGNUP_POLICY, AUTH_SIGNUP_ALLOWED_DOMAINS and PROBER_AUTH_URL (the kernel refuses a sign-up policy that
# needs the bundled proxy; the prober then follows PUBLIC_AUTH_URL). Every other line stays as it is, AUTH_JWT_SECRET included.

AUTH_SETTING_NAMES=(AUTH_ISSUER AUTH_JWKS_URL PUBLIC_AUTH_URL PUBLIC_AUTH_ANON_KEY AUTH_ALLOWED_EMAILS AUTH_OAUTH_PROVIDERS AUTH_HOSTED_LOGIN_URL AUTH_HOSTED_LOGIN_TOKEN_URL AUTH_HOSTED_LOGIN_NAME)
AUTH_SETTING_REQUIRED=(AUTH_ISSUER AUTH_JWKS_URL PUBLIC_AUTH_URL PUBLIC_AUTH_ANON_KEY AUTH_ALLOWED_EMAILS)
AUTH_SETTING_DROPPED=(AUTH_SIGNUP_POLICY AUTH_SIGNUP_ALLOWED_DOMAINS PROBER_AUTH_URL)
# The result of auth_settings_load: the values by name (an associative array, declared there so that the other commands, smoke
# included, still load under bash 3), and the lines to write.
AUTH_LINES=()

# An https address of a host name (no IP address, no localhost), an optional port and a plain path: no user, query or fragment.
# (The last label starts with a letter and, like every label, does not end in a dash: the kernel's own rule, so an address that passes
# here cannot stop the worker from booting.)
AUTH_URL_RE='^https://(([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9]))(:([0-9]{1,5}))?(/[A-Za-z0-9._~/-]*)?$'
AUTH_DOMAIN_RE='([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])'
# (A repetition count above 255 is refused by the regex library, so the length is checked apart.)
AUTH_KEY_RE='^[A-Za-z0-9._-]+$'
AUTH_PROVIDER_RE='^[a-z][a-z0-9_]{0,31}$'

auth_url_ok() {
  [ "${#1}" -le 2048 ] && [[ "$1" =~ $AUTH_URL_RE ]] || return 1
  [[ "$1" != *..* ]] || return 1
  # localhost and *.localhost are this machine, whatever the scheme.
  local host="${1#https://}"
  host="${host%%[/:]*}"
  host="${host,,}"
  [[ "$host" != localhost && "$host" != *.localhost ]] || return 1
  [ -z "${BASH_REMATCH[6]}" ] || ((10#${BASH_REMATCH[6]} >= 1 && 10#${BASH_REMATCH[6]} <= 65535))
}

# The scheme and host (and port) of an address that passed auth_url_ok, in lower case.
auth_origin() {
  local hostpart="${1#https://}" origin
  origin="https://${hostpart%%/*}"
  origin="${origin,,}"
  printf '%s' "${origin%:443}"
}

# A button label: at most 40 characters (the kernel's limit; bytes on a host without a UTF-8 locale), no control character, no quote, backslash, dollar, backtick,
# `#`, `=` or other character a shell, a comment or compose's interpolation could act on, and no space at either end.
auth_name_ok() {
  # Bytes, whatever the host's locale (an SSH session may have none): characters are the bytes that are not UTF-8 continuation bytes.
  local LC_ALL=C value="$1" bad=$'\'"\\$`#<>;&|(){}!*?~%=[]' i chars
  chars="${value//[$'\x80'-$'\xbf']/}"
  [ -n "$value" ] && [ "${#chars}" -le 40 ] && [ "${#value}" -le 160 ] || return 1
  [[ ! "$value" =~ [[:cntrl:]] ]] || return 1
  [[ "$value" != [[:space:]]* && "$value" != *[[:space:]] ]] || return 1
  for ((i = 0; i < ${#bad}; i++)); do
    [[ "$value" != *"${bad:i:1}"* ]] || return 1
  done
}

# Splits a list into AUTH_ITEMS on commas and white space, as the kernel does: at least one item and at most $2.
AUTH_ITEMS=()
auth_split() {
  local raw="${1//,/ }" max="$2"
  AUTH_ITEMS=()
  [ "${#1}" -le 4096 ] || return 1
  # Through a pipe, not a here-string: an older bash writes a here-string to a temporary file, and the list may be the secret.
  read -r -a AUTH_ITEMS < <(printf '%s\n' "$raw") || true
  ((${#AUTH_ITEMS[@]} > 0 && ${#AUTH_ITEMS[@]} <= max))
}

# Addresses and @domain entries, comma separated; on success the list without spaces is AUTH_SET[AUTH_ALLOWED_EMAILS].
auth_emails_ok() {
  local entry out=''
  auth_split "$1" 200 || return 1
  for entry in "${AUTH_ITEMS[@]}"; do
    # (254 characters at most, as the kernel allows, for an @domain entry too.)
    [ "${#entry}" -le 254 ] || return 1
    if [[ "$entry" =~ ^@${AUTH_DOMAIN_RE}$ ]]; then :
    elif [[ "$entry" =~ ^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@${AUTH_DOMAIN_RE}$ && "${entry%@*}" != *..* ]]; then :
    else return 1
    fi
    out+="${out:+,}$entry"
  done
  AUTH_SET[AUTH_ALLOWED_EMAILS]="$out"
}

auth_providers_ok() {
  local entry out=''
  auth_split "$1" 12 || return 1
  for entry in "${AUTH_ITEMS[@]}"; do
    [[ "$entry" =~ $AUTH_PROVIDER_RE ]] || return 1
    out+="${out:+,}$entry"
  done
  AUTH_SET[AUTH_OAUTH_PROVIDERS]="$out"
}

# auth_settings_load <file>: checks the file and builds AUTH_LINES. Prints the names that fail, never a value. Returns 1 when
# anything fails (every failure is reported, not only the first).
auth_settings_load() {
  local file="$1" line key value name known bad=0
  declare -gA AUTH_SET=()
  AUTH_LINES=()
  if ! [ -f "$file" ] || ! [ -r "$file" ]; then
    err "the identity provider settings file is not readable: $file"
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    if ! [[ "$line" =~ ^([A-Z][A-Z0-9_]{0,63})=(.*)$ ]]; then
      err 'a line of the identity provider settings is not NAME=value'
      bad=1
      continue
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    known=0
    for name in "${AUTH_SETTING_NAMES[@]}"; do
      if [ "$name" = "$key" ]; then known=1; fi
    done
    if ((known == 0)); then
      err "unknown identity provider setting $key"
      bad=1
    elif [ -n "${AUTH_SET[$key]+x}" ]; then
      err "identity provider setting $key is given twice"
      bad=1
    else
      AUTH_SET[$key]="$value"
    fi
  done <"$file"
  ((bad == 0)) || return 1

  for name in "${AUTH_SETTING_REQUIRED[@]}"; do
    if [ -z "${AUTH_SET[$name]:-}" ]; then
      err "$name is required when any identity provider setting is given"
      bad=1
    fi
  done
  for name in AUTH_ISSUER AUTH_JWKS_URL PUBLIC_AUTH_URL AUTH_HOSTED_LOGIN_URL AUTH_HOSTED_LOGIN_TOKEN_URL; do
    if [ -n "${AUTH_SET[$name]:-}" ] && ! auth_url_ok "${AUTH_SET[$name]}"; then
      err "$name must be an https address of a host name, with a plain path and no query, fragment or user"
      bad=1
      AUTH_SET[$name]=''
    fi
  done
  # The provider's keys are served from its own origin: an issuer that names one origin and keys from another is a typo or a swap.
  if [ -n "${AUTH_SET[AUTH_ISSUER]:-}" ] && [ -n "${AUTH_SET[AUTH_JWKS_URL]:-}" ] && [ "$(auth_origin "${AUTH_SET[AUTH_ISSUER]}")" != "$(auth_origin "${AUTH_SET[AUTH_JWKS_URL]}")" ]; then
    err 'AUTH_ISSUER and AUTH_JWKS_URL must have the same origin'
    bad=1
  fi
  if [ -n "${AUTH_SET[PUBLIC_AUTH_ANON_KEY]:-}" ] && { [ "${#AUTH_SET[PUBLIC_AUTH_ANON_KEY]}" -lt 16 ] || [ "${#AUTH_SET[PUBLIC_AUTH_ANON_KEY]}" -gt 2048 ] || ! [[ "${AUTH_SET[PUBLIC_AUTH_ANON_KEY]}" =~ $AUTH_KEY_RE ]]; }; then
    err 'PUBLIC_AUTH_ANON_KEY must be 16 to 2048 characters of letters, digits, dot, dash and underscore'
    bad=1
  fi
  if [ -n "${AUTH_SET[AUTH_ALLOWED_EMAILS]:-}" ] && ! auth_emails_ok "${AUTH_SET[AUTH_ALLOWED_EMAILS]}"; then
    err 'AUTH_ALLOWED_EMAILS must be at most 200 email addresses or @domain entries, comma separated'
    bad=1
  fi
  if [ -n "${AUTH_SET[AUTH_OAUTH_PROVIDERS]:-}" ] && ! auth_providers_ok "${AUTH_SET[AUTH_OAUTH_PROVIDERS]}"; then
    err 'AUTH_OAUTH_PROVIDERS must be at most 12 provider ids of lower-case letters, digits and _, comma separated'
    bad=1
  fi
  if [ -n "${AUTH_SET[AUTH_HOSTED_LOGIN_URL]:-}" ] || [ -n "${AUTH_SET[AUTH_HOSTED_LOGIN_TOKEN_URL]:-}" ]; then
    if [ -z "${AUTH_SET[AUTH_HOSTED_LOGIN_URL]:-}" ] || [ -z "${AUTH_SET[AUTH_HOSTED_LOGIN_TOKEN_URL]:-}" ]; then
      err 'set both AUTH_HOSTED_LOGIN_URL and AUTH_HOSTED_LOGIN_TOKEN_URL, or neither'
      bad=1
    fi
  elif [ -n "${AUTH_SET[AUTH_HOSTED_LOGIN_NAME]:-}" ]; then
    err 'AUTH_HOSTED_LOGIN_NAME needs AUTH_HOSTED_LOGIN_URL and AUTH_HOSTED_LOGIN_TOKEN_URL'
    bad=1
  fi
  if [ -n "${AUTH_SET[AUTH_HOSTED_LOGIN_NAME]:-}" ] && ! auth_name_ok "${AUTH_SET[AUTH_HOSTED_LOGIN_NAME]}"; then
    err 'AUTH_HOSTED_LOGIN_NAME must be at most 40 characters of plain text: no quote, backslash, dollar, backtick, #, = or other shell or dotenv character'
    bad=1
  fi
  ((bad == 0)) || return 1

  for name in "${AUTH_SETTING_NAMES[@]}"; do
    value="${AUTH_SET[$name]:-}"
    [ -n "$value" ] || continue
    # The only value that may hold a space is the label, and it is single quoted (it holds no single quote).
    if [ "$name" = AUTH_HOSTED_LOGIN_NAME ]; then AUTH_LINES+=("$name='$value'"); else AUTH_LINES+=("$name=$value"); fi
  done
  AUTH_LINES+=('AUTH_SESSION_CHECK=jwt' 'AUTH_UPSTREAM_URL=')
}

# The names a settings file would set, for the log.
auth_set_names() {
  local line out=''
  for line in "${AUTH_LINES[@]}"; do out+="${out:+ }${line%%=*}"; done
  printf '%s' "$out"
}

# The dated copy of the env file, and whether this run replaced the file. Set by apply_env_settings; restore_env puts the copy back.
ENV_BACKUP='' ENV_CHANGED=0 ENV_WRITING=0 ENV_TMP='' ENV_WRITTEN_DIGEST='' ENV_UNDO='' ENV_UNDO_KIND='' ENV_RECORD='' ENV_PRE_DIGEST='' ENV_CHANGE_LABEL='the identity provider settings'

# env_digest <file>: a checksum of the file's content, read from stdin so that nothing of it is an argument. It tells a rollback whether
# the env file is still what the deploy wrote.
env_digest() {
  if command -v sha256sum >/dev/null; then sha256sum <"$1" | cut -d' ' -f1; else cksum <"$1" | tr ' ' '-'; fi
}

# restore_env: puts the copy made by apply_env_settings back over the env file (into the file itself, so its owner, mode and inode stay).
# Nothing to do when this run changed nothing. Returns 1 when the copy could not be put back; its path is in the message.
restore_env() {
  [ "$ENV_CHANGED" = 1 ] || return 0
  if { cat "$ENV_BACKUP" >"$ENV_FILE" && cmp -s "$ENV_BACKUP" "$ENV_FILE"; }; then
    log "restored $ENV_FILE from $ENV_BACKUP (the file as it was before ${ENV_CHANGE_LABEL:-the identity provider settings})"
    ENV_CHANGED=0
    return 0
  fi
  err "putting $ENV_FILE back from $ENV_BACKUP failed: copy that file (mode 600) over the env file by hand"
  return 1
}

# restore_env_of <release>: a rollback from a release whose deploy replaced the env file puts the dated copy back first, so the older
# release runs with the settings it ran with. A deploy that left the file alone (or an older one) leaves no record for it. Only a file
# that is still what that deploy wrote is replaced: edits made since (a rotated password, a new setting) are never overwritten, and the
# message says so. The file as it is now is kept in ENV_UNDO until the rollback has worked, so a rollback that fails (recover) puts it back.
restore_env_of() {
  local rel='' path='' digest='' stamp kind=''
  read -r rel path digest < <(read_state env-backup) || true
  [ -n "$rel" ] && [ "$rel" = "$1" ] || return 0
  kind="$(read_state env-backup-kind)"
  if [ "$kind" = module ]; then ENV_CHANGE_LABEL='the module settings'; else ENV_CHANGE_LABEL='the identity provider settings'; fi
  ENV_UNDO_KIND="$kind"
  ENV_RECORD="$rel $path $digest"
  rm -f "$(state_dir)/env-backup" "$(state_dir)/env-backup-kind"
  if ! { valid_path "$path" && [ -f "$path" ]; }; then
    err "the dated copy of the env file that release $rel replaced is gone; the env file stays as it is"
    return 0
  fi
  if [ -z "$digest" ] || [ "$(env_digest "$ENV_FILE")" != "$digest" ]; then
    err "$ENV_FILE was edited after release $rel wrote $ENV_CHANGE_LABEL, so it is left as it is (the copy from before them is $path; take what you need from it by hand)"
    return 0
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  ENV_UNDO="$(mktemp "$ENV_FILE.bak-$stamp-XXXXXX")" || {
    err "cannot keep a copy of $ENV_FILE before putting the old settings back; the env file stays as it is"
    ENV_UNDO=''
    return 0
  }
  if ! { cat "$ENV_FILE" >"$ENV_UNDO" && cmp -s "$ENV_FILE" "$ENV_UNDO"; }; then
    err "cannot keep a copy of $ENV_FILE before putting the old settings back; the env file stays as it is"
    rm -f "$ENV_UNDO"
    ENV_UNDO=''
    return 0
  fi
  ENV_BACKUP="$path"
  ENV_CHANGED=1
  restore_env || die "$EXIT_ROLLBACK_FAILED" "the env file could not be put back from $path: the instance needs an operator (the file as it was is $ENV_UNDO)"
}

# undo_env_restore: a rollback that failed goes back to the release it left, with the settings that release ran with.
undo_env_restore() {
  [ -n "$ENV_UNDO" ] || return 0
  if { cat "$ENV_UNDO" >"$ENV_FILE" && cmp -s "$ENV_UNDO" "$ENV_FILE"; }; then
    log "put $ENV_CHANGE_LABEL back in $ENV_FILE (the rollback failed)"
    (umask 077; write_state env-backup "$ENV_RECORD")
    if [ -n "$ENV_UNDO_KIND" ]; then (umask 077; write_state env-backup-kind "$ENV_UNDO_KIND"); fi
    rm -f "$ENV_UNDO"
  else
    err "the rollback failed and the env file could not be put back as it was: the settings are in $ENV_UNDO (mode 600); copy that file over $ENV_FILE"
    return 1
  fi
  ENV_UNDO='' ENV_UNDO_KIND=''
}

# prune_env_backups: the dated copies of the env file next to it (apply_env_settings) are kept for the newest KEEP_ENV_BACKUPS, and
# the one the rollback record points to. They hold the old secrets, so they do not pile up.
prune_env_backups() {
  local keep f i n=0
  local -a copies=()
  keep="$(read_state env-backup | cut -d' ' -f2)"
  for f in "$ENV_FILE".bak-[0-9]*Z-*; do
    if [ -f "$f" ]; then copies+=("$f"); fi
  done
  # The time is in the name, so the glob lists them oldest first.
  for ((i = ${#copies[@]} - 1; i >= 0; i--)); do
    n=$((n + 1))
    if ((n > KEEP_ENV_BACKUPS)) && [ "${copies[i]}" != "$keep" ]; then
      log "removing old env file copy ${copies[i]}"
      rm -f "${copies[i]}"
    fi
  done
}

# probe_get <url> [headers file]: prints the body of an answer 200 from an https address, with no redirect followed (a redirect could
# leave https or reach another host) and no other scheme.
probe_get() {
  local url="$1" headers="${2:-}" out code
  # -q first: a ~/.curlrc of the host (a proxy, a redirect setting) is not read.
  local -a args=(-q --silent --show-error --max-time 15 --proto "=https" --proto-redir "=https" --write-out '%{http_code}')
  [ -z "$headers" ] || args+=(--header "@$headers")
  out="$(curl "${args[@]}" "$url")" || return 1
  code="${out: -3}"
  [ "$code" = 200 ] || return 1
  printf '%s' "${out%???}"
}

# auth_settings_probe: before anything changes, the provider answers: its keys (a JWKS with "keys") and its Auth URL's /health with the
# publishable key. Well-formed but wrong values (the project URL without /auth/v1, a typo in the keys path) would otherwise pass every
# check, boot, and lock everyone out. The key goes to curl in a header file, not as an argument (the two addresses are public).
auth_settings_probe() {
  local headers keys_url="${AUTH_SET[AUTH_JWKS_URL]}" auth_url="${AUTH_SET[PUBLIC_AUTH_URL]}" body ok=1
  headers="$(mktemp "$(state_dir)/probe.XXXXXX")" || {
    err 'cannot make a temporary file to check the identity provider'
    return 1
  }
  printf 'apikey: %s\n' "${AUTH_SET[PUBLIC_AUTH_ANON_KEY]}" >"$headers"
  # At least one key, and one the kernel verifies with (ES256 or RS256: an EC or RSA key); a set with no key, or with shared (oct) keys only,
  # would boot and then refuse every token.
  if body="$(probe_get "$keys_url")" && [[ "$body" =~ \"keys\"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{ ]] && [[ "$body" =~ \"kty\"[[:space:]]*:[[:space:]]*\"(EC|RSA)\" ]]; then log 'identity provider: AUTH_JWKS_URL answers with an ES256 or RS256 key'; else
    err 'identity provider: AUTH_JWKS_URL does not answer 200 with a JSON Web Key Set that holds an EC or RSA key (a redirect is not followed)'
    ok=0
  fi
  # GoTrue's health answer says so: the app's own page (this API's address by mistake) also answers 200 to any GET.
  if body="$(probe_get "${auth_url%/}/health" "$headers")" && [[ "$body" == *GoTrue* ]]; then log 'identity provider: PUBLIC_AUTH_URL answers /health'; else
    err 'identity provider: PUBLIC_AUTH_URL/health does not answer 200 with the Auth service (is it the Auth URL, ending /auth/v1, and the publishable key right? a redirect is not followed)'
    ok=0
  fi
  rm -f "$headers"
  ((ok))
}

# apply_env_settings <has_auth 0|1> <has_modules 0|1> <modules_list>: writes AUTH_LINES and/or CROVE_MODULES=<list>
# into $ENV_FILE in one atomic pass, after keeping a single dated copy next to it (mode 600).
# Returns 0 (done, or the file already had exactly these settings: then no copy is made), 1 (nothing changed) or 2 (the write
# failed and the file could not be put back: the copy is kept and named).
apply_env_settings() {
  # Never traced: a `set -x` of a caller would print the values.
  { set +x; } 2>/dev/null
  local has_auth="$1" has_modules="$2" modules_list="${3:-}"
  local line key cr='' lines stamp removed='' name found written_count=0 mod_line=0 n=0 mod_seen=0
  local -A managed=() dropped=()
  local -a gone=() written=()
  ENV_TMP="$(mktemp "$(state_dir)/env-next.XXXXXX")" || {
    err "cannot make a temporary file for $ENV_CHANGE_LABEL; the env file was not touched"
    ENV_TMP=''
    return 1
  }
  if ((has_auth)); then
    for key in "${AUTH_SETTING_NAMES[@]}" AUTH_SESSION_CHECK AUTH_UPSTREAM_URL "${AUTH_SETTING_DROPPED[@]}"; do managed[$key]=1; done
    for key in "${AUTH_SETTING_DROPPED[@]}"; do dropped[$key]=1; done
  fi
  # Pre-scan for CRLF endings across the whole file and the last CROVE_MODULES assignment line.
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    if [ "${line: -1}" = $'\r' ]; then cr=$'\r'; fi
    if ((has_modules)) && [[ "${line%$'\r'}" =~ ^[[:space:]]*(export[[:space:]]+)?CROVE_MODULES[[:space:]]*[=:] ]]; then
      mod_line=$n
    fi
  done <"$ENV_FILE"
  n=0
  {
    while IFS= read -r line || [ -n "$line" ]; do
      n=$((n + 1))
      if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*[=:] ]]; then
        key="${BASH_REMATCH[2]}"
        if ((has_auth)) && [ -n "${managed[$key]:-}" ]; then
          if [ -n "${dropped[$key]:-}" ]; then gone+=("$key"); fi
          continue
        fi
        if ((has_modules)) && [ "$key" = CROVE_MODULES ]; then
          if [ "$n" = "$mod_line" ]; then
            printf 'CROVE_MODULES=%s%s\n' "$modules_list" "$cr"
            written_count=$((written_count + 1))
          fi
          continue
        fi
      fi
      printf '%s\n' "$line"
      written_count=$((written_count + 1))
    done <"$ENV_FILE"
    if ((has_modules && mod_line == 0)); then
      printf 'CROVE_MODULES=%s%s\n' "$modules_list" "$cr"
      written_count=$((written_count + 1))
    fi
    # Lines added to a file with Windows line breaks get them too.
    if ((has_auth)); then
      for line in "${AUTH_LINES[@]}"; do
        printf '%s%s\n' "$line" "$cr"
        written_count=$((written_count + 1))
      done
    fi
  } >"$ENV_TMP" || {
    err 'writing the new env file failed (is the disk full?); the env file was not touched'
    return 1
  }
  lines=$(($(wc -l <"$ENV_TMP")))
  if [ "$lines" != "$written_count" ]; then
    err 'the new env file is incomplete (is the disk full?); the env file was not touched'
    return 1
  fi
  # With builtins only: a settings line (the allowed addresses are a secret) is never an argument of another process.
  mapfile -t written <"$ENV_TMP"
  if ((has_modules)); then
    for key in "${written[@]}"; do
      if [ "$key" = "CROVE_MODULES=$modules_list$cr" ]; then
        mod_seen=$((mod_seen + 1))
      elif [[ "${key%$'\r'}" =~ ^[[:space:]]*(export[[:space:]]+)?CROVE_MODULES[[:space:]]*[=:] ]]; then
        err 'the new env file has an unexpected CROVE_MODULES line; the env file was not touched'
        return 1
      fi
    done
    if [ "$mod_seen" != 1 ]; then
      err 'the new env file is incomplete; the env file was not touched'
      return 1
    fi
  fi
  if ((has_auth)); then
    for line in "${AUTH_LINES[@]}"; do
      found=0
      for key in "${written[@]}"; do
        if [ "$key" = "$line$cr" ]; then
          found=1
          break
        fi
      done
      if ((found == 0)); then
        err 'the new env file is incomplete; the env file was not touched'
        return 1
      fi
    done
  fi
  if cmp -s "$ENV_TMP" "$ENV_FILE"; then
    if ((has_auth)); then log "identity provider settings already in $ENV_FILE: nothing to write"; fi
    if ((has_modules)); then log "module settings already in $ENV_FILE: nothing to write"; fi
    rm -f "$ENV_TMP"
    ENV_TMP=''
    return 0
  fi

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  ENV_PRE_DIGEST="$(env_digest "$ENV_FILE")"
  ENV_BACKUP="$(mktemp "$ENV_FILE.bak-$stamp-XXXXXX")" || {
    err "cannot keep a dated copy of $ENV_FILE next to it (mode 600); the env file was not touched"
    ENV_BACKUP=''
    return 1
  }
  if ! { cat "$ENV_FILE" >"$ENV_BACKUP" && cmp -s "$ENV_FILE" "$ENV_BACKUP"; }; then
    err "cannot keep a dated copy of $ENV_FILE next to it; the env file was not touched"
    rm -f "$ENV_BACKUP"
    ENV_BACKUP=''
    return 1
  fi
  # Into the file itself, not a rename: the owner, the mode and the inode of the env file stay. A write that fails or is cut off
  # is put back from the copy; if that fails too, the copy is kept and named.
  ENV_WRITING=1
  if ! { cat "$ENV_TMP" >"$ENV_FILE" && cmp -s "$ENV_TMP" "$ENV_FILE"; }; then
    ENV_CHANGED=1
    if restore_env; then
      ENV_WRITING=0
      err "writing $ENV_CHANGE_LABEL into $ENV_FILE failed; the file was put back as it was"
      return 1
    fi
    ENV_WRITING=0
    ENV_CHANGED=0
    return 2
  fi
  ENV_WRITING=0
  ENV_CHANGED=1
  ENV_WRITTEN_DIGEST="$(env_digest "$ENV_FILE")"
  rm -f "$ENV_TMP"
  ENV_TMP=''
  if ((has_auth)); then
    # Names only, never a value.
    for name in "${gone[@]+"${gone[@]}"}"; do
      case " $removed " in *" $name "*) ;; *) removed+="${removed:+ }$name" ;; esac
    done
    log "identity provider settings written to $ENV_FILE; set: $(auth_set_names); removed: ${removed:-none}; the previous file is $ENV_BACKUP (mode 600)"
  fi
  if ((has_modules)); then
    log "module settings written to $ENV_FILE: CROVE_MODULES=$modules_list; the previous file is $ENV_BACKUP (mode 600)"
  fi
}

# Installs this script on the host for manual rollbacks (when it is not already that copy).
install_self() {
  local self target
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  target="$(state_dir)/deploy.sh"
  [ "$self" != "$target" ] || return 0
  if ! { cp -f "$self" "$target.tmp" && chmod 0755 "$target.tmp" && mv -f "$target.tmp" "$target"; }; then
    err "could not install $target; a manual rollback needs a copy of this script"
  fi
}

prune_releases() {
  local current previous keep=0 d name
  current="$(read_state current)"
  previous="$(read_state previous)"
  # Newest first, by the time each release was staged (recorded in its release.env).
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    name="$(basename "$d")"
    keep=$((keep + 1))
    if ((keep > KEEP_RELEASES)) && [ "$name" != "$current" ] && [ "$name" != "$previous" ]; then
      log "removing old release $name"
      rm -rf "$d"
    fi
  done < <(for d in "$DEPLOY_DIR"/releases/*/; do if [ -f "$d/release.env" ]; then printf '%s %s\n' "$(sed -n 's/^STAGED_AT=//p' "$d/release.env")" "${d%/}"; fi; done | sort -r | cut -d' ' -f2-)
}

# recover <release> <what> <failed release>: rolls back to a release after a failed deploy or rollback, in the order
# its build needs against the failed one (direction_to). Exit 1 when it is serving again, 3 when not.
recover() {
  local target="$1" what="$2" failed="$3"
  # The settings of this deploy go out first, so the older release runs with the env file it ran with.
  if ! restore_env; then
    record "$what failed, and so did putting the env file back"
    die "$EXIT_ROLLBACK_FAILED" "$what failed and the env file could not be put back: the instance needs an operator"
  fi
  SMOKE_EXPECT_AUTH_URL=''
  SMOKE_EXPECT_MODULES=''
  if ! undo_env_restore; then
    record "$what failed, and so did putting the env file back"
    die "$EXIT_ROLLBACK_FAILED" "$what failed and the env file could not be put back: the instance needs an operator"
  fi
  if [ -z "$target" ]; then
    record "$what failed, nothing to roll back to"
    die "$EXIT_FAILED" "$what failed and there is no earlier release to roll back to; the failed release is left as it is"
  fi
  log "rolling back to $target"
  activate "$target"
  if roll_services "$(direction_to "$target" "$failed")"; then
    record "$what failed, rolled back to $target"
    die "$EXIT_FAILED" "$what failed; rolled back to $target, which serves again"
  fi
  record "$what failed, rollback to $target FAILED"
  die "$EXIT_ROLLBACK_FAILED" "$what failed and the rollback to $target failed too: the instance needs an operator"
}

# Options both deploy and rollback take. Sets OPT_SHIFT to the number of arguments used (0: not one of these).
REGISTRY='' REGISTRY_USER='' REGISTRY_PASSWORD='' READ_PASSWORD=0 OPT_SHIFT=0
common_option() {
  OPT_SHIFT=2
  case "$1" in
    --dir) DEPLOY_DIR="${2:-}" ;;
    --env-file) ENV_FILE="${2:-}" ;;
    --registry) REGISTRY="${2:-}" ;;
    --registry-user) REGISTRY_USER="${2:-}" ;;
    --registry-password-stdin) READ_PASSWORD=1 OPT_SHIFT=1 ;;
    *) OPT_SHIFT=0 ;;
  esac
}

# Reads the registry password from stdin (one line) when asked to; never from an argument or the environment.
read_registry_password() {
  ((READ_PASSWORD)) || return 0
  [[ "$REGISTRY" =~ ^[a-z0-9.-]+(:[0-9]+)?$ ]] || die "$EXIT_USAGE" "--registry must be a host name: '$REGISTRY'"
  [[ "$REGISTRY_USER" =~ ^[A-Za-z0-9._-]+(\[bot\])?$ ]] || die "$EXIT_USAGE" "--registry-user is required with --registry-password-stdin"
  IFS= read -r REGISTRY_PASSWORD || true
  [ -n "$REGISTRY_PASSWORD" ] || die "$EXIT_USAGE" 'no registry password on stdin'
}

do_deploy() {
  local release="" image="" extract="" media="" compose="" build="" build_given=0 auth_settings="" modules_list="" modules_given=0
  while (($# > 0)); do
    case "$1" in
      --release) release="${2:-}"; shift 2 ;;
      --image) image="${2:-}"; shift 2 ;;
      --extract-image) extract="${2:-}"; shift 2 ;;
      --media-image) media="${2:-}"; shift 2 ;;
      --compose) compose="${2:-}"; shift 2 ;;
      --build) build="${2:-}"; build_given=1; shift 2 ;;
      --auth-settings) auth_settings="${2:-}"; shift 2 ;;
      --modules)
        (($# >= 2)) || die "$EXIT_USAGE" '--modules requires a comma-separated module list'
        modules_list="$2"
        modules_given=1
        shift 2
        ;;
      *)
        common_option "$@"
        ((OPT_SHIFT > 0)) || die "$EXIT_USAGE" "unknown option $1"
        shift "$OPT_SHIFT"
        ;;
    esac
  done
  valid_release "$release" || die "$EXIT_USAGE" "--release must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}: '$release'"
  valid_image "$image" || die "$EXIT_USAGE" "--image must be pinned by digest (name@sha256:...): '$image'"
  valid_image "$extract" || die "$EXIT_USAGE" "--extract-image must be pinned by digest (name@sha256:...): '$extract'"
  valid_image "$media" || die "$EXIT_USAGE" "--media-image must be pinned by digest (name@sha256:...): '$media'"
  [ -f "$compose" ] || die "$EXIT_USAGE" "--compose file not found: '$compose'"
  ((build_given == 0)) || valid_build "$build" || die "$EXIT_USAGE" "--build must match [A-Za-z0-9._-]{1,64}: '$build'"
  if ((modules_given)); then
    modules_validate "$modules_list" || die "$EXIT_USAGE" '--modules is not valid (see above); nothing was changed'
  fi
  # The identity provider settings are checked before anything is pulled or changed (#2704): a bad value stops the deploy here.
  if [ -n "$auth_settings" ]; then
    valid_path "$auth_settings" || die "$EXIT_USAGE" "--auth-settings must be an absolute path without spaces: '$auth_settings'"
    # Never the env file or the compose file by mistake (it would be read as settings, and removed below).
    if [ "$auth_settings" -ef "${ENV_FILE:-$DEPLOY_DIR/.env}" ] || [ "$auth_settings" -ef "$compose" ]; then
      die "$EXIT_USAGE" '--auth-settings is the settings file the workflow uploads, not the env file or the compose file; nothing was changed'
    fi
    # The file the workflow uploaded (in its private incoming directory) is read once and removed whatever the outcome: the secret in it
    # need not stay on the host. Any other file named here is read and left alone.
    # (Only <dir>/.deploy/incoming/<run>/auth-settings.env, as a regular file that is not a link, with no `..` in the run's name.)
    local incoming=0 under="${auth_settings#"$DEPLOY_DIR"/.deploy/incoming/}"
    if [ "$under" != "$auth_settings" ] && [[ "$under" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*/auth-settings\.env$ ]] && [ -f "$auth_settings" ] && [ ! -L "$auth_settings" ]; then incoming=1; fi
    if ! auth_settings_load "$auth_settings"; then
      if ((incoming)); then rm -f "$auth_settings"; fi
      die "$EXIT_USAGE" 'the identity provider settings are not valid (see above); nothing was changed'
    fi
    if ((incoming)); then rm -f "$auth_settings"; fi
  fi
  if [ -n "$auth_settings" ]; then
    ENV_CHANGE_LABEL='the identity provider settings'
  elif ((modules_given)); then
    ENV_CHANGE_LABEL='the module settings'
  fi
  read_registry_password
  preflight
  if [ -n "$auth_settings" ] || ((modules_given)); then
    # Found out now: a write that fails halfway is the one thing that can leave the env file broken.
    { [ -w "$ENV_FILE" ] && [ -w "$(dirname "$ENV_FILE")" ]; } || die "$EXIT_USAGE" "$ENV_CHANGE_LABEL need $ENV_FILE and its directory writable by the deploy user (the dated copy goes next to it); nothing was changed"
  fi
  if [ -n "$auth_settings" ]; then
    auth_settings_probe || die "$EXIT_FAILED" 'the identity provider does not answer as these settings say; nothing was changed'
  fi
  context_token_key_preflight
  acquire_lock

  local digest name dir current
  digest="${image##*@sha256:}"
  name="$release-${digest:0:12}"
  dir="$DEPLOY_DIR/releases/$name"
  guard_run "deploy $name"
  install_self
  current="$(read_state current)"
  log "deploying $release ($name); running now: ${current:-nothing}"
  if [ -n "$auth_settings" ]; then
    log "identity provider settings given: $(auth_set_names)"
    # The smoke test of this deploy must see the Auth URL it was given (and recover, for the release before, must not).
    SMOKE_EXPECT_AUTH_URL="${AUTH_SET[PUBLIC_AUTH_URL]}"
  else
    SMOKE_EXPECT_AUTH_URL=''
  fi
  if ((modules_given)); then
    log "module settings given: CROVE_MODULES=$modules_list"
    SMOKE_EXPECT_MODULES="$modules_list"
  else
    SMOKE_EXPECT_MODULES=''
  fi

  # Stage the release (before anything changes, so a failure here leaves the running stack alone).
  mkdir -p "$dir"
  cp -f "$compose" "$dir/docker-compose.yml"
  # The pilot's compose file travels with the release, from the directory of its compose file.
  if [ -f "$(dirname "$compose")/compose.pilot.yml" ]; then cp -f "$(dirname "$compose")/compose.pilot.yml" "$dir/compose.pilot.yml"; fi
  write_override "$image" "$extract" "$media" >"$dir/docker-compose.override.yml"
  # In the pilot layout the release, or at least the host, must have the file: found out now, before anything is pulled or changed.
  if pilot_layout && [ ! -f "$dir/compose.pilot.yml" ] && [ ! -f "$DEPLOY_DIR/compose.pilot.yml" ]; then
    die "$EXIT_USAGE" "COMPOSE_FILE in $ENV_FILE lists compose.pilot.yml but this release does not carry it (it ships tools/deploy/compose.pilot.yml next to its compose file) and $DEPLOY_DIR has none"
  fi
  printf 'RELEASE=%s\nIMAGE=%s\nEXTRACT_IMAGE=%s\nMEDIA_IMAGE=%s\nBUILD=%s\nSTAGED_AT=%s\n' "$release" "$image" "$extract" "$media" "$build" "$(date -u +%Y%m%dT%H%M%S.%NZ)" >"$dir/release.env"

  if ! pull_images "$image" "$extract" "$media" "$REGISTRY" "$REGISTRY_USER" "$REGISTRY_PASSWORD"; then
    record "deploy $name failed: pull"
    die "$EXIT_FAILED" 'pulling the images failed; nothing was changed'
  fi
  # The build time the image carries, which orders the rolls (#1965).
  printf 'BUILD_EPOCH=%s\n' "$(image_build_epoch "$image")" >>"$dir/release.env"

  activate "$name"
  # Check the merged files before touching any container.
  if ! dc config --quiet; then
    if [ -n "$current" ]; then activate "$current"; fi
    record "deploy $name failed: compose config"
    die "$EXIT_FAILED" 'the compose files do not load with this env file; nothing was changed'
  fi

  log 'starting the database'
  if ! up db; then
    recover "$current" "deploy $name (database)" "$name"
  fi
  # The production steps of #1822 and #1750 (docs/runbooks/deploy.md), on the host, with the database up and before
  # `migrate`, which installs the key: make the context token key when the env file has none, and count the plain
  # idempotency rows (this one never fails the deploy).
  if ! ensure_context_token_key; then
    if [ -n "$current" ]; then activate "$current"; fi
    record "deploy $name failed: context token key"
    die "$EXIT_FAILED" "the context token key could not be written into $ENV_FILE; the services were not changed${current:+ ($current still runs)}"
  fi
  count_plain_idempotency_rows
  # Migrations first, with the new image. They are forward only: the running release keeps working on the new
  # schema (expand and contract), so a failure here needs no rollback of the services.
  log 'running migrations'
  if ! dc run --rm --no-TTY --no-deps migrate; then
    if [ -n "$current" ]; then activate "$current"; fi
    record "deploy $name failed: migrate"
    die "$EXIT_FAILED" "migrations failed; the services were not changed${current:+ ($current still runs)}. Fix forward with a new migration"
  fi

  # The identity provider and module settings go into the env file now, after the migration (forward only, it needs none of them) and right
  # before the services are recreated with them. Anything that fails from here puts the dated copy back (recover).
  if [ -n "$auth_settings" ] || ((modules_given)); then
    local applied=0 has_auth=0
    if [ -n "$auth_settings" ]; then has_auth=1; fi
    apply_env_settings "$has_auth" "$modules_given" "$modules_list" || applied=$?
    if ((applied == 2)); then
      if [ -n "$current" ]; then activate "$current"; fi
      record "deploy $name failed: $ENV_CHANGE_LABEL, and the env file could not be put back"
      die "$EXIT_ROLLBACK_FAILED" "writing $ENV_CHANGE_LABEL failed and the env file could not be put back: the instance needs an operator"
    fi
    if ((applied != 0)); then
      if [ -n "$current" ]; then activate "$current"; fi
      record "deploy $name failed: $ENV_CHANGE_LABEL"
      die "$EXIT_FAILED" "$ENV_CHANGE_LABEL could not be written into $ENV_FILE; the services were not changed${current:+ ($current still runs)}"
    fi
    if [ "$ENV_CHANGED" = 1 ] && ! dc config --quiet; then
      if ! restore_env; then
        if [ -n "$current" ]; then activate "$current"; fi
        record "deploy $name failed: compose config with $ENV_CHANGE_LABEL, and the env file could not be put back"
        die "$EXIT_ROLLBACK_FAILED" "the compose files do not load with $ENV_CHANGE_LABEL and the env file could not be put back: the instance needs an operator"
      fi
      if [ -n "$current" ]; then activate "$current"; fi
      record "deploy $name failed: compose config with $ENV_CHANGE_LABEL"
      die "$EXIT_FAILED" "the compose files do not load with $ENV_CHANGE_LABEL; the env file was put back and nothing running was changed"
    fi
  fi

  if ! roll_services "$(direction_to "$name" "$current")"; then
    recover "$current" "deploy $name" "$name"
  fi

  if [ "$current" != "$name" ]; then
    if [ -n "$current" ]; then write_state previous "$current"; fi
    write_state current "$name"
  fi
  # A rollback from this release puts the env file back only when this deploy is the one that changed it.
  # (A deploy of the same release again, that changed nothing, keeps the record: that release is still the one that wrote them.)
  if [ "$ENV_CHANGED" = 1 ]; then
    # The same release deployed again with other settings keeps the copy from before its first deploy: that is the one a rollback needs.
    # Only while the file is still what that first deploy wrote: edits made since are in the new copy, which is then the one a rollback restores
    # (the earlier one would put the old values over them).
    local first_rel='' first_path='' first_digest=''
    read -r first_rel first_path first_digest < <(read_state env-backup) || true
    if [ "$first_rel" != "$name" ]; then
      (umask 077; write_state env-backup "$name $ENV_BACKUP $ENV_WRITTEN_DIGEST")
      if [ -n "$auth_settings" ]; then rm -f "$(state_dir)/env-backup-kind"; else (umask 077; write_state env-backup-kind module); fi
    elif [ "$first_digest" = "$ENV_PRE_DIGEST" ] && valid_path "$first_path" && [ -f "$first_path" ]; then
      (umask 077; write_state env-backup "$name $first_path $ENV_WRITTEN_DIGEST")
      if [ -n "$auth_settings" ]; then rm -f "$(state_dir)/env-backup-kind"; fi
    else
      # Edited in between: neither copy can be put back without losing either those edits or the settings of the first deploy. A rollback
      # leaves the file as it is, as it does for any edited file.
      rm -f "$(state_dir)/env-backup" "$(state_dir)/env-backup-kind"
      log "$ENV_FILE was edited after release $name first wrote $ENV_CHANGE_LABEL: a rollback will leave it as it is (the copy from before them is $first_path)"
    fi
  elif [ "$(read_state env-backup | cut -d' ' -f1)" != "$name" ]; then
    rm -f "$(state_dir)/env-backup" "$(state_dir)/env-backup-kind"
  fi
  record "deploy $name ok image=$image extract=$extract media=$media$([ "$ENV_CHANGED" = 1 ] && echo ' env=changed')"
  prune_releases
  if [ "$ENV_CHANGED" = 1 ] || [ -n "$auth_settings" ] || ((modules_given)); then prune_env_backups; fi
  log "deployed $release ($name)"
}

do_rollback() {
  # A rollback goes back to settings without the remote provider or deploy-time module expectations: neither is demanded of it.
  SMOKE_EXPECT_AUTH_URL=''
  SMOKE_EXPECT_MODULES=''
  while (($# > 0)); do
    common_option "$@"
    ((OPT_SHIFT > 0)) || die "$EXIT_USAGE" "unknown option $1"
    shift "$OPT_SHIFT"
  done
  read_registry_password
  preflight
  acquire_lock
  local current previous
  current="$(read_state current)"
  previous="$(read_state previous)"
  guard_run "rollback to ${previous:-nothing}"
  install_self
  [ -n "$previous" ] || die "$EXIT_USAGE" 'no previous release is recorded; deploy a release instead'
  [ -f "$DEPLOY_DIR/releases/$previous/release.env" ] || die "$EXIT_USAGE" "the previous release $previous is no longer on the host"
  log "rolling back from ${current:-nothing} to $previous (images and compose files only; the schema stays)"
  restore_env_of "$current"
  # The images are normally still on the host. Pull them again (by digest, so nothing else can arrive) in case
  # they were pruned; without registry credentials a private image that is gone cannot come back.
  if ! pull_images "$(release_field "$previous" IMAGE)" "$(release_field "$previous" EXTRACT_IMAGE)" "$(release_field "$previous" MEDIA_IMAGE)" "$REGISTRY" "$REGISTRY_USER" "$REGISTRY_PASSWORD"; then
    log 'pulling the previous images failed; trying with the images on the host'
  fi
  # Usually toward an older build, the API first; back to a newer one (a second rollback), the worker first (#1965).
  activate "$previous"
  if ! roll_services "$(direction_to "$previous" "$current")"; then
    recover "$current" "rollback to $previous" "$previous"
  fi
  # Swap, so a second rollback returns to the release just left.
  write_state previous "$current"
  write_state current "$previous"
  # The settings it put back worked: the copy of the file as it was is no longer needed.
  if [ -n "$ENV_UNDO" ]; then rm -f "$ENV_UNDO"; ENV_UNDO=''; ENV_UNDO_KIND=''; fi
  record "rollback to $previous ok"
  log "rolled back to $previous"
}


do_status() {
  while (($# > 0)); do
    case "$1" in
      --dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
      *) die "$EXIT_USAGE" "unknown option $1" ;;
    esac
  done
  printf 'current:  %s\nprevious: %s\n' "$(read_state current)" "$(read_state previous)"
  if [ -f "$(state_dir)/history.log" ]; then tail -n 10 "$(state_dir)/history.log"; fi
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    deploy) do_deploy "$@" ;;
    rollback) do_rollback "$@" ;;
    status) do_status "$@" ;;
    check-auth-settings)
      [ -n "${1:-}" ] || die "$EXIT_USAGE" 'usage: deploy.sh check-auth-settings <file>'
      auth_settings_load "$1" || die "$EXIT_USAGE" 'the identity provider settings are not valid (see above)'
      log "identity provider settings ok; they set: $(auth_set_names)"
      ;;
    check-modules)
      (($# == 1)) || die "$EXIT_USAGE" 'usage: deploy.sh check-modules <list>'
      modules_validate "$1" || die "$EXIT_USAGE" 'the module list is not valid (see above)'
      log "module settings ok: CROVE_MODULES=$1"
      ;;
    smoke)
      [ -n "${1:-}" ] || die "$EXIT_USAGE" 'usage: deploy.sh smoke <base url> [build id]'
      [ -z "${2:-}" ] || valid_build "$2" || die "$EXIT_USAGE" "the build id must match [A-Za-z0-9._-]{1,64}: '$2'"
      smoke "$1" account "${2:-}" || die "$EXIT_FAILED" "smoke test failed on $1"
      ;;
    *) die "$EXIT_USAGE" 'usage: deploy.sh deploy|rollback|status|smoke|check-auth-settings|check-modules (see the header of this file)' ;;
  esac
}

main "$@"
