import pytest

from common.settings import Settings
from tests.fakes import FakeCache, FakeDb, FakeQueue
from web.app import create_app


def make(cache=None, queue=None, db=None):
    db, cache, queue = db or FakeDb(), cache or FakeCache(), queue or FakeQueue()
    app = create_app(db, cache, queue, Settings.from_env())
    return app.test_client(), db, cache, queue


def test_health_is_shallow_even_when_dependencies_down():
    c, *_ = make(cache=FakeCache(broken=True), queue=FakeQueue(fail=True))
    assert c.get("/health").status_code == 200


def test_ready_reports_failures():
    c, *_ = make(cache=FakeCache(broken=True))
    r = c.get("/ready")
    assert r.status_code == 503 and r.get_json()["checks"]["cache"] is False


def test_cache_aside_miss_then_hit():
    c, db, *_ = make()
    assert c.get("/api/products").headers["X-Cache"] == "MISS"
    assert c.get("/api/products").headers["X-Cache"] == "HIT"
    assert db.list_calls == 1


def test_cache_failure_falls_back_to_db():
    c, db, *_ = make(cache=FakeCache(broken=True))
    r = c.get("/api/products")
    assert r.status_code == 200 and r.headers["X-Cache"] == "MISS"


def test_order_is_persisted_and_queued():
    c, db, _, q = make()
    r = c.post("/api/orders", json={"product_id": 1, "quantity": 2})
    assert r.status_code == 202
    oid = r.get_json()["order_id"]
    assert db.orders[oid]["status"] == "PENDING"
    assert q.sent == [{"type": "order", "order_id": oid}]


@pytest.mark.parametrize("body,code", [({"product_id": "x"}, 400), ({"product_id": 1, "quantity": 0}, 400),
                                       ({"product_id": 99}, 404)])
def test_order_validation(body, code):
    c, *_ = make()
    assert c.post("/api/orders", json=body).status_code == code


def test_queue_failure_marks_order_failed():
    c, db, *_ = make(queue=FakeQueue(fail=True))
    r = c.post("/api/orders", json={"product_id": 1})
    assert r.status_code == 503
    assert db.orders[r.get_json()["order_id"]]["status"] == "FAILED"


def test_get_order_and_404():
    c, db, *_ = make()
    oid = c.post("/api/orders", json={"product_id": 1}).get_json()["order_id"]
    assert c.get(f"/api/orders/{oid}").get_json()["status"] == "PENDING"
    assert c.get("/api/orders/nope").status_code == 404


def test_stats():
    c, *_ = make()
    assert "queue" in c.get("/api/stats").get_json()


def test_unknown_route_is_404_not_500():
    c, *_ = make()
    assert c.get("/nope").status_code == 404
