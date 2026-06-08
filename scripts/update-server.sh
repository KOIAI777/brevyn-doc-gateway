#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8090/healthz}"
LOCK_FILE="${LOCK_FILE:-/tmp/brevyn-doc-gateway-update.lock}"
COMPOSE="${COMPOSE:-docker compose}"
UPDATE_MODE="${UPDATE_MODE:-image}"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-ghcr.io/koiai777/brevyn-doc-gateway}"

log() {
  printf '[brevyn-doc-gateway-update] %s\n' "$*"
}

cd "$APP_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another update is already running"
  exit 1
fi

OLD_COMMIT="$(git rev-parse HEAD)"
log "current commit: $OLD_COMMIT"

image_for_commit() {
  printf '%s:sha-%s' "$IMAGE_REPOSITORY" "$(git rev-parse --short=7 "$1")"
}

OLD_IMAGE="$(image_for_commit "$OLD_COMMIT")"

backup_config() {
  if [ ! -f "data/config.json" ]; then
    log "no data/config.json yet; skip config backup"
    return 0
  fi
  mkdir -p backups/manual
  local backup_path="backups/manual/config_$(date +%Y%m%d_%H%M%S).json"
  cp data/config.json "$backup_path"
  log "backup config to $backup_path"
}

wait_for_health() {
  log "waiting for $HEALTH_URL"
  for _ in $(seq 1 60); do
    if curl -fsS "$HEALTH_URL" >/dev/null; then
      log "health check passed"
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  log "rolling back to $OLD_COMMIT"
  git reset --hard "$OLD_COMMIT"
  if [ "$UPDATE_MODE" = "build" ]; then
    $COMPOSE up -d --build
  else
    export BREVYN_DOC_GATEWAY_IMAGE="$OLD_IMAGE"
    log "restart previous image: $BREVYN_DOC_GATEWAY_IMAGE"
    $COMPOSE pull brevyn-doc-gateway || log "previous image pull failed; trying local cached image"
    $COMPOSE up -d
  fi
}

log "fetch latest code"
git fetch origin "$BRANCH"
git merge --ff-only "origin/$BRANCH"
NEW_COMMIT="$(git rev-parse HEAD)"

log "validate compose"
$COMPOSE config --quiet

backup_config

if [ "$UPDATE_MODE" = "build" ]; then
  log "build and restart service"
  $COMPOSE up -d --build
else
  export BREVYN_DOC_GATEWAY_IMAGE="$(image_for_commit "$NEW_COMMIT")"
  log "pull GHCR image and restart service: $BREVYN_DOC_GATEWAY_IMAGE"
  $COMPOSE pull brevyn-doc-gateway
  $COMPOSE up -d
fi

if wait_for_health; then
  log "update succeeded: $(git rev-parse HEAD)"
  exit 0
fi

log "health check failed"
rollback
log "rollback finished; inspect logs with: $COMPOSE logs -f brevyn-doc-gateway"
exit 1
