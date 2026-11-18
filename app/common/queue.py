"""Thin SQS wrapper."""
import json
import logging
from typing import Any, Dict, List

import boto3

from .settings import Settings

log = logging.getLogger("queue")


class Queue:
    def __init__(self, settings: Settings, client=None):
        self._url = settings.queue_url
        self._c = client or boto3.client("sqs", region_name=settings.region)

    def send(self, body: Dict[str, Any]) -> str:
        resp = self._c.send_message(QueueUrl=self._url, MessageBody=json.dumps(body))
        return resp["MessageId"]

    def receive(self, max_messages: int = 10, wait: int = 20) -> List[Dict[str, Any]]:
        resp = self._c.receive_message(
            QueueUrl=self._url, MaxNumberOfMessages=max_messages, WaitTimeSeconds=wait,
            AttributeNames=["ApproximateReceiveCount"],
        )
        return resp.get("Messages", [])

    def delete(self, receipt_handle: str) -> None:
        self._c.delete_message(QueueUrl=self._url, ReceiptHandle=receipt_handle)

    def depth(self) -> Dict[str, int]:
        a = self._c.get_queue_attributes(
            QueueUrl=self._url,
            AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        )["Attributes"]
        return {"visible": int(a["ApproximateNumberOfMessages"]),
                "in_flight": int(a["ApproximateNumberOfMessagesNotVisible"])}

    def ping(self) -> bool:
        try:
            self.depth()
            return True
        except Exception:  # noqa: BLE001
            return False
