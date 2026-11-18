"""PostgreSQL access with a pooled connection and retry across RDS Multi-AZ failover.

During a failover the instance endpoint CNAME flips to the standby, existing sockets die
and new connections fail for roughly 60 to 120 seconds. Every call therefore retries on
connection level errors, discards the broken pool and reconnects.
"""
import logging
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

import psycopg2
from psycopg2 import pool as pgpool

from .settings import Settings

log = logging.getLogger("db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
);
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
"""

SEED = [
    ("Safaricom MiFi Router", 4500), ("Solar Lantern", 2200), ("Smartphone 6.1in", 18900),
    ("USB-C Charger 30W", 1500), ("Wireless Earbuds", 3900), ("Power Bank 20000mAh", 3200),
]

RETRYABLE = (psycopg2.OperationalError, psycopg2.InterfaceError)


class Database:
    def __init__(self, settings: Settings, retries: int = 6, backoff: float = 1.0):
        self._s = settings
        self._retries = retries
        self._backoff = backoff
        self._pool: Optional[pgpool.ThreadedConnectionPool] = None
        self._lock = threading.Lock()

    # pool management
    def _get_pool(self) -> pgpool.ThreadedConnectionPool:
        with self._lock:
            if self._pool is None:
                self._pool = pgpool.ThreadedConnectionPool(
                    1, 10, host=self._s.db_host, port=self._s.db_port, dbname=self._s.db_name,
                    user=self._s.db_user, password=self._s.db_password, connect_timeout=5,
                    sslmode="require",
                )
            return self._pool

    def _reset_pool(self) -> None:
        with self._lock:
            if self._pool is not None:
                try:
                    self._pool.closeall()
                except Exception:  # noqa: BLE001
                    pass
                self._pool = None

    @contextmanager
    def _conn(self):
        pool = self._get_pool()
        conn = pool.getconn()
        try:
            yield conn
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            try:
                pool.putconn(conn)
            except Exception:  # noqa: BLE001
                pass

    def _run(self, fn):
        last: Optional[Exception] = None
        for attempt in range(1, self._retries + 1):
            try:
                with self._conn() as conn:
                    with conn.cursor() as cur:
                        return fn(cur)
            except RETRYABLE as exc:
                last = exc
                log.warning("db call failed, retrying", extra={"fields": {"attempt": attempt, "error": str(exc)[:200]}})
                self._reset_pool()
                time.sleep(min(self._backoff * attempt, 10))
        raise RuntimeError(f"database unavailable after {self._retries} attempts") from last

    # operations
    def init_schema(self) -> None:
        def work(cur):
            cur.execute(SCHEMA)
            cur.execute("SELECT count(*) FROM products")
            if cur.fetchone()[0] == 0:
                cur.executemany("INSERT INTO products (name, price_cents) VALUES (%s, %s)", SEED)
        self._run(work)

    def ping(self) -> bool:
        self._run(lambda cur: cur.execute("SELECT 1"))
        return True

    def list_products(self) -> List[Dict[str, Any]]:
        def work(cur):
            cur.execute("SELECT id, name, price_cents FROM products ORDER BY id")
            return [{"id": r[0], "name": r[1], "price_cents": r[2]} for r in cur.fetchall()]
        return self._run(work)

    def create_order(self, product_id: int, quantity: int) -> str:
        order_id = str(uuid.uuid4())

        def work(cur):
            cur.execute("INSERT INTO orders (id, product_id, quantity) VALUES (%s, %s, %s)",
                        (order_id, product_id, quantity))
        self._run(work)
        return order_id

    def product_exists(self, product_id: int) -> bool:
        def work(cur):
            cur.execute("SELECT 1 FROM products WHERE id = %s", (product_id,))
            return cur.fetchone() is not None
        return self._run(work)

    def get_order(self, order_id: str) -> Optional[Dict[str, Any]]:
        def work(cur):
            cur.execute("SELECT id, product_id, quantity, status, created_at, updated_at FROM orders WHERE id = %s",
                        (order_id,))
            r = cur.fetchone()
            if not r:
                return None
            return {"id": str(r[0]), "product_id": r[1], "quantity": r[2], "status": r[3],
                    "created_at": r[4].isoformat(), "updated_at": r[5].isoformat()}
        return self._run(work)

    def set_order_status(self, order_id: str, status: str) -> None:
        def work(cur):
            cur.execute("UPDATE orders SET status = %s, updated_at = now() WHERE id = %s", (status, order_id))
        self._run(work)

    def order_counts(self) -> Dict[str, int]:
        def work(cur):
            cur.execute("SELECT status, count(*) FROM orders GROUP BY status")
            return {r[0]: r[1] for r in cur.fetchall()}
        return self._run(work)
