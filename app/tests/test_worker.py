import pytest

from tests.fakes import FakeDb
from worker.processor import PermanentError, handle


def test_order_flow_completes():
    db = FakeDb()
    oid = db.create_order(1, 1)
    handle({"type": "order", "order_id": oid}, db, 0)
    assert db.orders[oid]["status"] == "COMPLETED"


def test_order_is_idempotent():
    db = FakeDb()
    oid = db.create_order(1, 1)
    db.set_order_status(oid, "COMPLETED")
    handle({"type": "order", "order_id": oid}, db, 0)
    assert db.orders[oid]["status"] == "COMPLETED"


def test_synthetic_message_sleeps_without_db():
    handle({"type": "synthetic", "seconds": 0}, None, 0)


@pytest.mark.parametrize("msg", [{"type": "order", "order_id": "missing"}, {"type": "bogus"}])
def test_permanent_errors(msg):
    with pytest.raises(PermanentError):
        handle(msg, FakeDb(), 0)
