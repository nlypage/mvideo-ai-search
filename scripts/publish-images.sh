#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/nlypage/mvideo-ai-search}"
PLATFORM="${PLATFORM:-linux/amd64}"
SHA_TAG="$(git rev-parse --short HEAD)"

if ! docker buildx inspect >/dev/null 2>&1; then
  docker buildx create --use >/dev/null
fi

publish_mode() {
  local mode="$1"
  docker buildx build \
    --platform "$PLATFORM" \
    --build-arg "VITE_APP_MODE=$mode" \
    --build-arg "VITE_LOW_MEMORY_BUILD=${VITE_LOW_MEMORY_BUILD:-0}" \
    --tag "$IMAGE:$mode-latest" \
    --tag "$IMAGE:$mode-$SHA_TAG" \
    --push \
    .
}

publish_mode client
publish_mode consultant

echo "Published:"
echo "  $IMAGE:client-latest"
echo "  $IMAGE:consultant-latest"
echo "  $IMAGE:client-$SHA_TAG"
echo "  $IMAGE:consultant-$SHA_TAG"
