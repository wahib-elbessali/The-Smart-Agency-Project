"""Which manual commands each device type accepts - read from
contracts/device-commands.json, the one list the backend, the dashboard and
the hardware contract share (the firmware implements it by hand). Nothing
here is hardcoded: a new command is a line in that file."""

import json
from functools import lru_cache
from pathlib import Path

from app.core.config import settings

# core/backend/app/services/device_commands.py -> core/contracts/
DEFAULT_PATH = Path(__file__).resolve().parents[3] / "contracts" / "device-commands.json"


@lru_cache(maxsize=1)
def load_commands() -> dict[str, list[dict[str, str]]]:
    """{DEVICE_TYPE: [{"action", "label"}]}. Keys starting with "_" are
    comments. A missing or broken file means no manual commands at all,
    never a crash."""
    path = Path(settings.device_commands_file) if settings.device_commands_file else DEFAULT_PATH
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out: dict[str, list[dict[str, str]]] = {}
    for device_type, commands in raw.items():
        if device_type.startswith("_") or not isinstance(commands, list):
            continue
        out[device_type.upper()] = [
            {"action": str(c["action"]).lower(), "label": str(c.get("label") or c["action"])}
            for c in commands
            if isinstance(c, dict) and c.get("action")
        ]
    return out


def actions_for(device_type: str) -> list[str]:
    return [c["action"] for c in load_commands().get((device_type or "").upper(), [])]
