#!/usr/bin/env bash
# Pull-based deploy: runs every minute from qlook-deploy.timer. When main has a
# new commit it builds the image (the build runs the tests), swaps the container,
# waits for the health check and rolls back to the previous image if it fails.
set -euo pipefail

REPO=https://github.com/alhamami911/Saas.git
BRANCH=${QLOOK_BRANCH:-main}
DIR=/opt/qlook
SRC=$DIR/src
STATE=$DIR/state
LOG=$DIR/deploy.log
HEALTH_URL=http://127.0.0.1:8098/healthz

exec 9>"$DIR/.deploy.lock"
flock -n 9 || exit 0
mkdir -p "$STATE"

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

[ -d "$SRC/.git" ] || git clone --quiet --branch "$BRANCH" "$REPO" "$SRC"
git -C "$SRC" fetch --quiet origin "$BRANCH"
SHA=$(git -C "$SRC" rev-parse FETCH_HEAD)
CURRENT=$(cat "$STATE/deployed" 2>/dev/null || true)
[ "$SHA" = "$CURRENT" ] && exit 0
# A commit that already failed is not retried; the next push gets a fresh attempt.
[ "$SHA" = "$(cat "$STATE/failed" 2>/dev/null || true)" ] && exit 0

TAG=${SHA:0:12}
log "deploying $TAG (current: ${CURRENT:0:12})"
git -C "$SRC" checkout --quiet --force "$SHA"
git -C "$SRC" clean -fdxq

if ! docker build --pull --build-arg GIT_SHA="$SHA" -t "qlook:$TAG" "$SRC" >"$STATE/build-$TAG.log" 2>&1; then
    log "build or tests FAILED for $TAG, still serving ${CURRENT:0:12} (log: $STATE/build-$TAG.log)"
    echo "$SHA" > "$STATE/failed"
    exit 1
fi

switch_to() {
    echo "IMAGE_TAG=$1" > "$DIR/.env"
    docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml" up -d --remove-orphans >>"$LOG" 2>&1
}

healthy() {
    for _ in $(seq 1 30); do
        if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q "\"version\":\"$1\""; then return 0; fi
        sleep 2
    done
    return 1
}

switch_to "$TAG"
if healthy "$SHA"; then
    echo "$SHA" > "$STATE/deployed"
    rm -f "$STATE/failed"
    log "deployed $TAG"
    # Keep the three newest images for manual rollback, drop the rest.
    docker images qlook --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' | sort -r | tail -n +4 | cut -f2 \
        | xargs -r docker rmi >/dev/null 2>&1 || true
    find "$STATE" -name 'build-*.log' -mtime +14 -delete
    exit 0
fi

log "health check FAILED for $TAG"
echo "$SHA" > "$STATE/failed"
if [ -n "$CURRENT" ]; then
    switch_to "${CURRENT:0:12}"
    log "rolled back to ${CURRENT:0:12}"
fi
exit 1
