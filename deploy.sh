#!/usr/bin/env bash
# deploy.sh — update the running calypso-app image to a new tag and wait for
# the rollout to complete.
#
# Usage:
#   ./deploy.sh <image-tag>
#
# Example:
#   ./deploy.sh sha-abc1234
#   ./deploy.sh v1.2.3
#
# The image repository is ghcr.io/<owner>/calypso-starter-ts. Replace <owner>
# with the actual GitHub organisation or user before using in production.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <image-tag>" >&2
  exit 1
fi

IMAGE_TAG="$1"
IMAGE="ghcr.io/<owner>/calypso-starter-ts:${IMAGE_TAG}"

echo "Deploying ${IMAGE} ..."
kubectl set image deployment/calypso-app app="${IMAGE}"
kubectl rollout status deployment/calypso-app
echo "Deployment of ${IMAGE} complete."
