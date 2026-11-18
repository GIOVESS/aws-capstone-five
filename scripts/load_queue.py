#!/usr/bin/env python3
"""Fill the work queue with synthetic messages to trigger worker scale-out.

Usage: python3 scripts/load_queue.py --count 3000 --seconds 3
Each message makes one worker thread sleep for N seconds, so queue depth stays high long
enough for target tracking to add tasks.
"""
import argparse
import json
import logging
import sys

import boto3

log = logging.getLogger("load_queue")


def queue_url(stack: str, region: str) -> str:
    cf = boto3.client("cloudformation", region_name=region)
    outputs = cf.describe_stacks(StackName=stack)["Stacks"][0]["Outputs"]
    for o in outputs:
        if o["OutputKey"] == "QueueUrl":
            return o["OutputValue"]
    raise SystemExit("QueueUrl output not found")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=3000)
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--stack", default="Cap5Platform")
    ap.add_argument("--region", default="us-east-1")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

    sqs = boto3.client("sqs", region_name=args.region)
    url = queue_url(args.stack, args.region)
    sent = failed = 0
    batch = []
    for i in range(args.count):
        batch.append({"Id": str(i % 10), "MessageBody": json.dumps({"type": "synthetic", "seconds": args.seconds})})
        if len(batch) == 10 or i == args.count - 1:
            resp = sqs.send_message_batch(QueueUrl=url, Entries=batch)
            sent += len(resp.get("Successful", []))
            failed += len(resp.get("Failed", []))
            batch = []
            if sent % 500 == 0:
                log.info("sent %d", sent)
    log.info("done: sent=%d failed=%d", sent, failed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
