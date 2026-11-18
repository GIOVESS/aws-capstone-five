"""ECS task metadata (v4) so the UI can show which AZ and task answered."""
import json
import logging
import os
import urllib.request
from typing import Dict

log = logging.getLogger("meta")
_cached: Dict[str, str] = {}


def task_meta() -> Dict[str, str]:
    if _cached:
        return _cached
    base = os.environ.get("ECS_CONTAINER_METADATA_URI_V4")
    if not base:
        _cached.update({"az": "local", "task": "local"})
        return _cached
    try:
        with urllib.request.urlopen(base + "/task", timeout=1) as r:  # nosec B310
            data = json.loads(r.read())
        _cached.update({"az": data.get("AvailabilityZone", "unknown"),
                        "task": data.get("TaskARN", "unknown").split("/")[-1][:12]})
    except Exception as exc:  # noqa: BLE001
        log.warning("metadata lookup failed", extra={"fields": {"error": str(exc)[:100]}})
        _cached.update({"az": "unknown", "task": "unknown"})
    return _cached
