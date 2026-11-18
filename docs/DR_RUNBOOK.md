# Disaster recovery runbook

Scope: the Cap5 platform in us-east-1. Every command can be run from AWS CloudShell inside the `aws-capstone-five` folder. The scripts resolve resource names from the `Cap5Platform` stack outputs, so nothing needs to be edited.

## Recovery objectives

| Failure | Protection | Expected RTO | Expected RPO |
|---|---|---|---|
| One AZ unavailable (tasks, RDS primary, cache primary) | Tasks in both AZs behind the ALB, RDS Multi-AZ standby, cache replica with automatic failover | Under 2 minutes | 0 for the database (synchronous replication) |
| RDS primary instance failure | Automatic Multi-AZ failover, the endpoint name does not change | 1 to 2 minutes | 0 |
| Cache node failure | Replica promotion. The application treats the cache as optional and reads from PostgreSQL meanwhile | Seconds, no outage | Not applicable (cache only) |
| Whole web tier down or ALB unhealthy | Route 53 failover record serves the static page from S3 | About 1 to 2 minutes (2 failed checks at 10 s plus a 60 s alias TTL) | 0 |
| Bad release | ECS deployment circuit breaker rolls back to the last healthy task definition | A few minutes | 0 |
| Data corruption or deleted data | AWS Backup daily snapshot, 14 day retention, restore into a new instance | 20 to 40 minutes | Up to 24 hours |

## What is monitored

* CloudWatch dashboard `cap5-platform`: queue depth against worker tasks, ALB requests against web tasks, CPU, healthy targets, Route 53 health, DLQ depth.
* Alarms to the SNS email topic: `cap5-DlqNotEmpty`, `cap5-Web5xx`, `cap5-WebUnhealthy`, `cap5-Route53Primary`.

## Scenario 1: database failover (Multi-AZ)

Trigger a drill:

```bash
./scripts/rds_failover.sh
```

What to expect: the script prints the primary and standby AZ before, forces a failover, then probes the site every 10 seconds. `GET /api/products` keeps returning 200 because the answer is served from the cache. `POST /api/orders` may return 5xx for roughly one minute while the endpoint moves, then returns 202 again. Afterwards the primary and standby AZ values are swapped.

Why `/health` stays green: it does not touch the database, so a database failover does not make Route 53 fail over the whole site. Deep checks live on `/ready`.

Real incident: no action needed. Confirm with `aws rds describe-events` and check that `Web5xx` returned to OK.

## Scenario 2: web tier outage (Route 53 failover)

Trigger a drill:

```bash
./scripts/simulate_failover.sh down
./scripts/simulate_failover.sh watch
```

Sequence: no healthy targets, the ALB answers 503, the Route 53 health check turns unhealthy after 2 failed checks, the PRIMARY record is withdrawn and the SECONDARY record (S3 website) is served. The `Route53Primary` alarm emails the team.

Recovery:

```bash
./scripts/simulate_failover.sh up
./scripts/simulate_failover.sh watch
```

Real incident: find the cause first (`aws ecs describe-services`, task stopped reasons, CloudWatch logs `/aws/ecs`), fix or roll back, then confirm the answer for the site name flips back to the ALB.

## Scenario 3: bad deployment

The pipeline deploys with a rolling update (100 percent minimum healthy, 200 percent maximum) and the deployment circuit breaker. If new tasks fail their health check the deployment rolls back automatically. To roll back by hand, redeploy the previous image tag:

```bash
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$PREVIOUS_TASK_DEFINITION_ARN"
```

## Scenario 4: restore data from AWS Backup

1. List recovery points:

   ```bash
   aws backup list-recovery-points-by-backup-vault --backup-vault-name cap5-vault \
     --query 'RecoveryPoints[].[RecoveryPointArn,CreationDate,Status]' --output table
   ```

2. Fetch the restore metadata for the chosen point, change `DBInstanceIdentifier` to a new name (restores never overwrite the running instance) and start the job:

   ```bash
   aws backup get-recovery-point-restore-metadata --backup-vault-name cap5-vault --recovery-point-arn "$POINT"
   aws backup start-restore-job --recovery-point-arn "$POINT" --iam-role-arn "$BACKUP_ROLE" --metadata file://restore.json
   ```

3. When the new instance is available, point the services at it by changing `DB_HOST` or by swapping the endpoint through a controlled stack update, then verify with `/ready`.

## Backup evidence

`./scripts/backup_now.sh` starts an on-demand job against the same vault and role the daily plan uses, waits for completion and lists the recovery points. The scheduled rule runs at 05:00 UTC and keeps points for 14 days.

## After any drill

Run `./scripts/status.sh`. Expected: web desired and running at 2, worker at 1 once the queue is empty, health check Success, DNS answer is the ALB address.
