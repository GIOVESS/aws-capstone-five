#!/usr/bin/env bash
# Build both images and push them as :bootstrap so ECS has something to start before the
# pipeline has ever run. Run once, after Cap5Foundation and before Cap5Platform.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

for svc in web worker; do
  repo="${REGISTRY}/cap5-${svc}"
  echo "Building ${svc}"
  docker build --platform linux/amd64 -f "app/${svc}/Dockerfile" -t "${repo}:bootstrap" app
  docker push "${repo}:bootstrap"
done
echo "Bootstrap images pushed."
