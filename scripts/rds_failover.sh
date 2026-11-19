#!/usr/bin/env bash
# RDS Multi-AZ failover drill. Forces the standby to take over and shows the application
# staying up (cached reads keep answering, writes recover once the new primary is reachable).
source "$(dirname "$0")/lib.sh"

DB="$(out DbInstanceId)"; ALB="$(out AlbDnsName)"

show() {
  aws rds describe-db-instances --db-instance-identifier "$DB" \
    --query 'DBInstances[0].{status:DBInstanceStatus,primaryAZ:AvailabilityZone,standbyAZ:SecondaryAvailabilityZone,multiAZ:MultiAZ}' --output table
}

before_az() { aws rds describe-db-instances --db-instance-identifier "$DB" --query 'DBInstances[0].AvailabilityZone' --output text; }
BEFORE="$(before_az)"
say "Before failover"; show
say "Forcing failover"
aws rds reboot-db-instance --db-instance-identifier "$DB" --force-failover >/dev/null

for i in $(seq 1 40); do
  products="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://${ALB}/api/products" || echo 000)"
  order="$(curl -s -o /dev/null -m 10 -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
          -d '{"product_id":1,"quantity":1}' "http://${ALB}/api/orders" || echo 000)"
  st="$(aws rds describe-db-instances --db-instance-identifier "$DB" --query 'DBInstances[0].DBInstanceStatus' --output text)"
  say "rds=${st} GET /api/products=${products} POST /api/orders=${order}"
  [ "$i" -gt 6 ] && [ "$st" = "available" ] && [ "$order" = "202" ] && break
  sleep 10
done

# The AZ readout can lag the "available" status, so wait up to 2 minutes for the swap.
for _ in $(seq 1 24); do
  [ "$(before_az)" != "$BEFORE" ] && break
  sleep 5
done
say "After failover (primary was ${BEFORE}, now $(before_az))"; show
aws rds describe-events --source-identifier "$DB" --source-type db-instance --duration 30 \
  --query 'Events[].[Date,Message]' --output text | grep -i -E 'failover|Multi-AZ' || true
