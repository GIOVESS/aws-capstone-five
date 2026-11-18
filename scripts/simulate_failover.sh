#!/usr/bin/env bash
# Route 53 failover drill.
#   ./scripts/simulate_failover.sh down     stop every web task: ALB health check fails, DNS flips to S3
#   ./scripts/simulate_failover.sh watch    poll DNS, health check and the HTTP response every 10 s
#   ./scripts/simulate_failover.sh up       restore the web tier: DNS flips back to the ALB
source "$(dirname "$0")/lib.sh"

CLUSTER="$(out ClusterName)"; WEB="$(out WebServiceName)"; HC="$(out HealthCheckId)"
SITE="$(out SiteUrl)"; FQDN="${SITE#http://}"
RESOURCE="service/${CLUSTER}/${WEB}"
MIN_UP="${MIN_UP:-2}"; MAX_UP="${MAX_UP:-6}"

scale_target() {
  aws application-autoscaling register-scalable-target --service-namespace ecs \
    --resource-id "$RESOURCE" --scalable-dimension ecs:service:DesiredCount \
    --min-capacity "$1" --max-capacity "$2" >/dev/null
}

case "${1:-}" in
  down)
    say "Simulating outage: scaling the web service to zero"
    scale_target 0 "$MAX_UP"          # otherwise auto scaling restores the minimum
    aws ecs update-service --cluster "$CLUSTER" --service "$WEB" --desired-count 0 >/dev/null
    say "Done. Run '$0 watch' and wait for the answer to change (about 1 to 2 minutes)."
    ;;
  up)
    say "Restoring the web service to ${MIN_UP} tasks"
    scale_target "$MIN_UP" "$MAX_UP"
    aws ecs update-service --cluster "$CLUSTER" --service "$WEB" --desired-count "$MIN_UP" >/dev/null
    say "Done. Run '$0 watch' and wait for the answer to flip back."
    ;;
  watch)
    for _ in $(seq 1 40); do
      status="$(aws route53 get-health-check-status --health-check-id "$HC" \
        --query 'HealthCheckObservations[].StatusReport.Status' --output text | tr '\t' '\n' | sort | uniq -c | tr '\n' ';')"
      code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://${FQDN}/health" || true)"
      body="$(curl -s -m 5 "http://${FQDN}/" | grep -o -m1 'We will be right back\|Resilient Shop' | head -1 || true)"
      say "dns=$(dig +short "$FQDN" | head -2 | tr '\n' ' ') http=${code} page='${body}' hc=${status}"
      sleep 10
    done
    ;;
  *) echo "usage: $0 down|watch|up"; exit 2 ;;
esac
