"""SQS consumer: long polling, thread pool, graceful SIGTERM so rolling updates and scale-in
never drop in-flight work. Failed messages are not deleted and reappear after the
visibility timeout; after maxReceiveCount they move to the DLQ."""
import json
import logging
import signal
import threading
from concurrent.futures import ThreadPoolExecutor

from common import logging_setup
from common.db import Database
from common.queue import Queue
from common.settings import Settings

from .processor import handle

log = logging.getLogger("worker")
stop = threading.Event()


def _process(raw, queue: Queue, db: Database, s: Settings) -> None:
    try:
        handle(json.loads(raw["Body"]), db, s.synthetic_seconds)
        queue.delete(raw["ReceiptHandle"])
    except Exception:  # noqa: BLE001
        log.exception("message failed", extra={"fields": {"id": raw.get("MessageId")}})


def run() -> None:
    logging_setup.configure()
    s = Settings.from_env()
    db = Database(s)
    db.init_schema()
    queue = Queue(s)
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    log.info("worker started", extra={"fields": {"threads": s.worker_threads, "version": s.app_version}})
    with ThreadPoolExecutor(max_workers=s.worker_threads) as pool:
        while not stop.is_set():
            try:
                msgs = queue.receive(max_messages=min(10, s.worker_threads), wait=20)
            except Exception:  # noqa: BLE001
                log.exception("receive failed")
                stop.wait(5)
                continue
            futures = [pool.submit(_process, m, queue, db, s) for m in msgs]
            for f in futures:
                f.result()
    log.info("worker stopped cleanly")


if __name__ == "__main__":
    run()
