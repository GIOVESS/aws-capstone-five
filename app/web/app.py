"""Web tier. Dependencies are injected so tests run against in-memory fakes."""
import logging
import time
from typing import Any

from flask import Flask, jsonify, render_template_string, request
from werkzeug.exceptions import HTTPException

from common import logging_setup
from common.settings import Settings

from .meta import task_meta
from .templates_html import PAGE

log = logging.getLogger("web")
PRODUCTS_KEY = "products:all"


def create_app(db: Any, cache: Any, queue: Any, settings: Settings) -> Flask:
    app = Flask(__name__)

    @app.get("/health")
    def health():
        # Shallow on purpose. Route 53 and the ALB use it, so a database failover must not
        # take the whole site out of DNS. Dependency state is reported by /ready.
        return jsonify(status="ok", version=settings.app_version), 200

    @app.get("/ready")
    def ready():
        checks = {"db": _safe(db.ping), "cache": _safe(cache.ping), "queue": _safe(queue.ping)}
        code = 200 if all(checks.values()) else 503
        return jsonify(checks=checks), code

    @app.get("/")
    def index():
        m = task_meta()
        return render_template_string(PAGE, version=settings.app_version, az=m["az"], task=m["task"])

    @app.get("/api/products")
    def products():
        start = time.perf_counter()
        cached = cache.get_json(PRODUCTS_KEY)
        if cached is not None:
            state, data = "HIT", cached
        else:
            data = db.list_products()
            cache.set_json(PRODUCTS_KEY, data)
            state = "MISS"
        resp = jsonify(products=data, az=task_meta()["az"])
        resp.headers["X-Cache"] = state
        resp.headers["X-Latency-Ms"] = f"{(time.perf_counter() - start) * 1000:.1f}"
        return resp

    @app.post("/api/orders")
    def create_order():
        body = request.get_json(silent=True) or {}
        try:
            product_id = int(body.get("product_id"))
            quantity = int(body.get("quantity", 1))
        except (TypeError, ValueError):
            return jsonify(error="product_id and quantity must be integers"), 400
        if quantity < 1 or quantity > 100:
            return jsonify(error="quantity must be between 1 and 100"), 400
        if not db.product_exists(product_id):
            return jsonify(error="unknown product"), 404
        order_id = db.create_order(product_id, quantity)
        try:
            queue.send({"type": "order", "order_id": order_id})
        except Exception:  # noqa: BLE001
            log.exception("enqueue failed", extra={"fields": {"order_id": order_id}})
            db.set_order_status(order_id, "FAILED")
            return jsonify(error="could not queue order", order_id=order_id), 503
        return jsonify(order_id=order_id, status="PENDING"), 202

    @app.get("/api/orders/<order_id>")
    def get_order(order_id: str):
        order = db.get_order(order_id)
        if not order:
            return jsonify(error="not found"), 404
        return jsonify(order)

    @app.get("/api/stats")
    def stats():
        return jsonify(orders=db.order_counts(), queue=queue.depth(), az=task_meta()["az"],
                       version=settings.app_version)

    @app.errorhandler(Exception)
    def on_error(exc):
        if isinstance(exc, HTTPException):
            return jsonify(error=exc.name), exc.code
        log.exception("unhandled error")
        return jsonify(error="internal error"), 500

    return app


def _safe(fn) -> bool:
    try:
        return bool(fn())
    except Exception:  # noqa: BLE001
        return False


def build() -> Flask:
    """Gunicorn entrypoint: `web.app:build()`."""
    from common.cache import Cache
    from common.db import Database
    from common.queue import Queue

    logging_setup.configure()
    s = Settings.from_env()
    db = Database(s)
    db.init_schema()
    return create_app(db, Cache(s), Queue(s), s)
