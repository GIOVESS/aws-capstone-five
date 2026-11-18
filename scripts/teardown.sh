#!/usr/bin/env bash
# Remove everything this project created, in dependency order.
# The backup vault cannot be deleted while it holds recovery points, so they are removed first.
set -euo pipefail
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
cd "$(dirname "$0")/../infrastructure"

read -r -p "Delete the Cap5 pipeline, platform, foundation stacks and all backups? Type yes: " ans
[ "$ans" = "yes" ] || { echo "aborted"; exit 1; }

# CDK needs the same inputs it was deployed with in order to synthesize.
: "${ZONE_NAME:?export ZONE_NAME first}"
: "${ALERT_EMAIL:?export ALERT_EMAIL first}"
export CONNECTION_ARN="${CONNECTION_ARN:-arn:aws:codeconnections:us-east-1:000000000000:connection/unused}"

echo "1/4 pipeline stack"
npx cdk destroy Cap5Pipeline --force || true

echo "2/4 backup recovery points"
VAULT="cap5-vault"
for arn in $(aws backup list-recovery-points-by-backup-vault --backup-vault-name "$VAULT" \
              --query 'RecoveryPoints[].RecoveryPointArn' --output text 2>/dev/null || true); do
  echo "  deleting $arn"
  aws backup delete-recovery-point --backup-vault-name "$VAULT" --recovery-point-arn "$arn"
done

echo "3/4 platform stack (RDS, cache, ECS, ALB, Route 53, vault)"
npx cdk destroy Cap5Platform --force

echo "4/4 foundation stack (ECR)"
npx cdk destroy Cap5Foundation --force
echo "Done. Remove the NS delegation records for ${ZONE_NAME} at your DNS provider."
