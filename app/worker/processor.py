"""Message handlers, kept free of SQS so they are trivially testable."""
import logging
import time
from typing import Any, Dict

log = logging.getLogger("processor")


class PermanentError(Exception):
    """Message can never succeed. It is left for the DLQ redrive policy."""


def handle(message: Dict[str, Any], db: Any, synthetic_seconds: float) -> None:
    kind = message.get("type")
    if kind == "order":
        order_id = message["order_id"]
        order = db.get_order(order_id)
        if order is None:
            raise PermanentError(f"order {order_id} not found")
        if order["status"] == "COMPLETED":
            return  # idempotent: standard queues deliver at least once
        db.set_order_status(order_id, "PROCESSING")
        time.sleep(synthetic_seconds)
        db.set_order_status(order_id, "COMPLETED")
        log.info("order completed", extra={"fields": {"order_id": order_id}})
    elif kind == "synthetic":
        time.sleep(float(message.get("seconds", synthetic_seconds)))
    else:
        raise PermanentError(f"unknown message type {kind!r}")
