#!/usr/bin/env bash
# Shared helpers. Source this file; do not run it.
set -euo pipefail

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
PLATFORM_STACK="${PLATFORM_STACK:-Cap5Platform}"

# out KEY -> value of a CloudFormation output of the platform stack
out() {
  aws cloudformation describe-stacks --stack-name "$PLATFORM_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

stamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
say() { printf '[%s] %s\n' "$(stamp)" "$*"; }
