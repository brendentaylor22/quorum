#!/bin/sh
# Start a built Quorum image and prove it actually serves.
#
# This exists because it did not. `packages/recommend` was missing from the
# runtime stage of the Dockerfile, so the image exited on startup with
# ERR_MODULE_NOT_FOUND — and every check passed anyway, because CI built the
# image, scanned it, generated an SBOM, and published it without ever running
# it. A green pipeline attested to an image that could not boot.
#
# So this is deliberately end-to-end rather than a unit test in disguise: it
# starts the container roughly as production does, waits for readiness, creates
# a real room over HTTP, and checks the client assets are present. Anything that
# breaks the packaged artefact rather than the source fails here.
#
# Usage: scripts/smoke-image.sh <image-ref>

set -eu

image=${1:-}
[ -n "$image" ] || { printf 'Usage: %s <image-ref>\n' "$0" >&2; exit 2; }

container=quorum-smoke-$$
volume=quorum-smoke-data-$$
port=${QUORUM_SMOKE_PORT:-18080}
base="http://127.0.0.1:$port"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker volume rm --force "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  printf '\nSMOKE FAILED: %s\n\n--- container logs ---\n' "$1" >&2
  docker logs "$container" 2>&1 | tail -40 >&2
  exit 1
}

printf 'Starting %s\n' "$image"
docker volume create "$volume" >/dev/null

# The same hardening the Compose topology applies, so a smoke test cannot pass
# on a container that only works with privileges production will not grant.
docker run --detach --name "$container" \
  --user 10001:10001 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:size=32m,mode=1777,noexec,nosuid,nodev \
  --mount "type=volume,source=$volume,target=/data" \
  --env QUORUM_TOKEN_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  --publish "127.0.0.1:$port:3000" \
  "$image" >/dev/null

# Readiness runs an integrity check against a freshly migrated database, so
# reaching it already proves migrations applied and SQLite is writable.
ready=''
attempt=0
while [ "$attempt" -lt 60 ]; do
  if curl --fail --silent --max-time 2 "$base/health/ready" >/dev/null 2>&1; then
    ready=yes
    break
  fi
  # An exited container will never become ready; say so now rather than in 60s.
  if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" != 'true' ]; then
    fail 'container exited before becoming ready'
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ -n "$ready" ] || fail 'never became ready'
printf 'ready\n'

# A real mutation through the real route table: capability minting, schema
# validation, and a durable write, none of which readiness touches.
room=$(curl --fail --silent --max-time 5 \
  --header 'x-quorum-request: 1' \
  --header 'content-type: application/json' \
  --request POST "$base/api/rooms" --data '{}') \
  || fail 'could not create a room'

case "$room" in
  *'"inviteToken"'*'"hostToken"'*) printf 'created a room\n' ;;
  *) fail "room response missing capabilities: $room" ;;
esac

host_token=$(printf '%s' "$room" | sed -n 's/.*"hostToken":"\([^"]*\)".*/\1/p')
[ -n "$host_token" ] || fail 'no host token in room response'

# The host capability answers, which means the whole capability path — hash,
# lookup, authorization — survived packaging.
curl --fail --silent --max-time 5 "$base/api/host/$host_token" >/dev/null \
  || fail 'host capability did not resolve'
printf 'host capability resolves\n'

# The image carries the built client, not just the server.
curl --fail --silent --max-time 5 "$base/" | grep -q '<div id="root">' \
  || fail 'client assets missing from the image'
printf 'client assets served\n'

curl --fail --silent --max-time 5 "$base/api/instance" | grep -q 'AGPL' \
  || fail 'instance endpoint did not report a licence'
printf 'instance endpoint answers\n'

# Redaction is a property of the shipped artefact, so it is checked here as
# well as in the unit suite: a logging change that survives tests but not the
# build would otherwise reach production silently.
if docker logs "$container" 2>&1 | grep -q "$host_token"; then
  fail 'the host capability appeared in the container logs'
fi
printf 'no capability token in logs\n'

printf '\nSMOKE PASSED: %s\n' "$image"
