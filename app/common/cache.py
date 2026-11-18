"""Redis/Valkey cache used with the cache-aside pattern. Fails open: a cache outage only
costs latency, it never fails a request."""
import json
import logging
from typing import Any, Optional

import redis

from .settings import Settings

log = logging.getLogger("cache")


class Cache:
    def __init__(self, settings: Settings, client: Optional[redis.Redis] = None):
        self._ttl = settings.cache_ttl
        if client is not None:
            self._r = client
        elif settings.redis_host:
            self._r = redis.Redis(
                host=settings.redis_host, port=settings.redis_port, ssl=settings.redis_tls,
                socket_timeout=0.5, socket_connect_timeout=0.5, decode_responses=True,
                health_check_interval=30,
            )
        else:
            self._r = None

    @property
    def enabled(self) -> bool:
        return self._r is not None

    def get_json(self, key: str) -> Optional[Any]:
        if not self._r:
            return None
        try:
            raw = self._r.get(key)
            return json.loads(raw) if raw else None
        except Exception as exc:  # noqa: BLE001
            log.warning("cache get failed", extra={"fields": {"key": key, "error": str(exc)[:200]}})
            return None

    def set_json(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        if not self._r:
            return
        try:
            self._r.set(key, json.dumps(value), ex=ttl or self._ttl)
        except Exception as exc:  # noqa: BLE001
            log.warning("cache set failed", extra={"fields": {"key": key, "error": str(exc)[:200]}})

    def delete(self, key: str) -> None:
        if not self._r:
            return
        try:
            self._r.delete(key)
        except Exception as exc:  # noqa: BLE001
            log.warning("cache delete failed", extra={"fields": {"key": key, "error": str(exc)[:200]}})

    def ping(self) -> bool:
        if not self._r:
            return True
        try:
            return bool(self._r.ping())
        except Exception:  # noqa: BLE001
            return False
