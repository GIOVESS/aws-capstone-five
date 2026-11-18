#!/usr/bin/env bash
# Start an on-demand AWS Backup job for the database so there is a recovery point to show
# without waiting for the daily 05:00 UTC schedule.
source "$(dirname "$0")/lib.sh"

VAULT="$(out VaultName)"; ARN="$(out DbArn)"; ROLE="$(out BackupRoleArn)"

JOB="$(aws backup start-backup-job --backup-vault-name "$VAULT" --resource-arn "$ARN" \
  --iam-role-arn "$ROLE" --query BackupJobId --output text)"
say "Started backup job $JOB"

for _ in $(seq 1 60); do
  state="$(aws backup describe-backup-job --backup-job-id "$JOB" --query State --output text)"
  say "state=$state"
  case "$state" in COMPLETED) break ;; FAILED|ABORTED|EXPIRED) exit 1 ;; esac
  sleep 20
done

aws backup list-recovery-points-by-backup-vault --backup-vault-name "$VAULT" \
  --query 'RecoveryPoints[].{status:Status,created:CreationDate,type:ResourceType,expires:CalculatedLifecycle.DeleteAt}' --output table
