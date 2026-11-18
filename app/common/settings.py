"""Environment driven settings shared by the web app and the worker."""
import os
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    redis_host: str
    redis_port: int
    redis_tls: bool
    queue_url: str
    region: str
    cache_ttl: int
    synthetic_seconds: float
    worker_threads: int
    app_version: str

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            db_host=os.environ.get("DB_HOST", "localhost"),
            db_port=_int("DB_PORT", 5432),
            db_name=os.environ.get("DB_NAME", "shop"),
            db_user=os.environ.get("DB_USER", "shop"),
            db_password=os.environ.get("DB_PASSWORD", ""),
            redis_host=os.environ.get("REDIS_HOST", ""),
            redis_port=_int("REDIS_PORT", 6379),
            redis_tls=os.environ.get("REDIS_TLS", "true").lower() == "true",
            queue_url=os.environ.get("QUEUE_URL", ""),
            region=os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1")),
            cache_ttl=_int("CACHE_TTL_SECONDS", 30),
            synthetic_seconds=float(os.environ.get("SYNTHETIC_SECONDS", "3")),
            worker_threads=_int("WORKER_THREADS", 4),
            app_version=os.environ.get("APP_VERSION", "dev"),
        )
