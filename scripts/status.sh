#!/usr/bin/env bash
# One-screen view of the platform: services, queue, targets, DNS, health check.
source "$(dirname "$0")/lib.sh"

CLUSTER="$(out ClusterName)"; WEB="$(out WebServiceName)"; WORKER="$(out WorkerServiceName)"
QUEUE="$(out QueueUrl)"; HC="$(out HealthCheckId)"; SITE="$(out SiteUrl)"; FQDN="${SITE#http://}"

say "ECS services"
aws ecs describe-services --cluster "$CLUSTER" --services "$WEB" "$WORKER" \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount}' --output table

say "Queue"
aws sqs get-queue-attributes --queue-url "$QUEUE" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --query 'Attributes' --output table

say "Route 53 health check (Success means the ALB is healthy)"
aws route53 get-health-check-status --health-check-id "$HC" \
  --query 'HealthCheckObservations[].StatusReport.Status' --output text | tr '\t' '\n' | sort | uniq -c

say "DNS answer for ${FQDN}"
dig +short "$FQDN" || true
