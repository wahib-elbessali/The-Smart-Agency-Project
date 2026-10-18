"""PATCH /config, POST /config/reload and the live-apply plumbing behind them.

Run from core/ai:  python -m pytest tests -q
Importing the app loads the feature modules (no models are loaded until the
background services start, and TestClient is used without its lifespan)."""
import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from features import config  # noqa: E402
from features.main import app  # noqa: E402
from features.weapon_detection import api as weapon  # noqa: E402
from features.wanted_detection import api as wanted  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A temp config.json, and every mutable the API touches put back after."""
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({"weapon": {"conf": 0.25}}))
    monkeypatch.setattr(config, "CONFIG_FILE", cfg_file)
    saved = copy.deepcopy(config.CONFIG)
    saved_pending = copy.deepcopy(config._pending_restart)
    saved_wanted = dict(wanted._config)
    saved_service = (weapon.service.update_interval, wanted.service.update_interval,
                     wanted.service.confirm_cycles, wanted.service.hold_cycles)
    yield TestClient(app)
    for feature, values in saved.items():
        config.CONFIG[feature].clear()
        config.CONFIG[feature].update(values)
    config._pending_restart.clear()
    config._pending_restart.update(saved_pending)
    wanted._config.update(saved_wanted)
    (weapon.service.update_interval, wanted.service.update_interval,
     wanted.service.confirm_cycles, wanted.service.hold_cycles) = saved_service


def patch(client, changes, persist=False):
    return client.patch("/config", json={"changes": changes, "persist": persist})


def test_live_change_reaches_the_running_detector_and_services(client, monkeypatch):
    seen = []
    monkeypatch.setattr(weapon, "detect_weapons", lambda frame, conf, imgsz: seen.append((conf, imgsz)) or [])

    weapon.service.detect_fn(None)
    response = patch(client, {"weapon": {"conf": 0.4, "imgsz": 800, "update_interval": 1.0},
                              "wanted": {"confirm_cycles": 4, "hold_cycles": 9, "threshold": 0.6}})
    assert response.status_code == 200
    weapon.service.detect_fn(None)

    assert seen == [(0.25, 640), (0.4, 800)]           # next cycle uses the new values
    assert weapon.service.update_interval == 1.0       # the sleep between cycles too
    assert (wanted.service.confirm_cycles, wanted.service.hold_cycles) == (4, 9)
    assert wanted._config["threshold"] == 0.6          # same state PUT /wanted/threshold edits
    assert client.get("/wanted/threshold").json()["threshold"] == 0.6


def test_get_config_reports_modes_startup_and_the_running_value(client):
    patch(client, {"weapon": {"conf": 0.4}})
    body = client.get("/config").json()
    assert body["config"]["weapon"]["conf"] == 0.4
    assert body["startup_config"]["weapon"]["conf"] != 0.4
    assert body["apply_modes"]["weapon"]["conf"] == "live"
    assert body["apply_modes"]["person_tracking"]["gate_pw"] == "next_start"
    assert body["apply_modes"]["wanted"]["det_size"] == "restart"


def test_old_wanted_threshold_endpoint_keeps_get_config_truthful(client):
    assert client.put("/wanted/threshold", json={"threshold": 0.7}).status_code == 200
    assert client.get("/config").json()["config"]["wanted"]["threshold"] == 0.7


@pytest.mark.parametrize("changes,fragment", [
    ({"weapon": {"conf": 25}}, "must be in"),
    ({"weapon": {"conf": True}}, "should be float"),
    ({"weapon": {"confidence": 0.3}}, "unknown key"),
    ({"weapon": {"imgsz": 500}}, "multiple of 32"),
    ({"wanted": {"threshold": 0.1}}, "false-alarms"),          # feature-owned floor
    ({"nope": {"a": 1}}, "unknown section"),
    ({"zoning": {"weights": "x.pt"}}, "persist=true"),         # restart-only without persist
])
def test_invalid_changes_are_422_with_a_reason(client, changes, fragment):
    response = patch(client, changes)
    assert response.status_code == 422
    assert fragment in " ".join(response.json()["detail"]["errors"])


def test_one_bad_value_applies_nothing(client):
    before = config.CONFIG["weapon"]["conf"]
    response = patch(client, {"weapon": {"conf": 0.4}, "fire": {"imgsz": 7}})
    assert response.status_code == 422
    assert config.CONFIG["weapon"]["conf"] == before


def test_persist_writes_the_file_and_defers_restart_only_keys(client, tmp_path):
    response = patch(client, {"weapon": {"conf": 0.33}, "face": {"pack": "buffalo_l"}}, persist=True)
    assert response.status_code == 200
    assert response.json()["pending_restart"] == {"face": {"pack": "buffalo_l"}}

    assert json.loads(config.CONFIG_FILE.read_text()) == {"weapon": {"conf": 0.33},
                                                          "face": {"pack": "buffalo_l"}}
    assert config.CONFIG["face"]["pack"] == "buffalo_s"        # still what is running
    assert client.get("/config").json()["pending_restart"] == {"face": {"pack": "buffalo_l"}}
    assert not list(tmp_path.glob("*.tmp"))                    # atomic replace left nothing behind


def test_without_persist_the_file_is_untouched(client):
    before = config.CONFIG_FILE.read_text()
    patch(client, {"weapon": {"conf": 0.4}})
    assert config.CONFIG_FILE.read_text() == before


def test_reload_applies_live_keys_and_reports_restart_keys(client):
    config.CONFIG_FILE.write_text(json.dumps({"fire": {"conf": 0.6}, "face": {"pack": "buffalo_l"}}))
    body = client.post("/config/reload").json()
    assert body["applied"]["fire"]["conf"]["value"] == 0.6
    assert body["pending_restart"] == {"face": {"pack": "buffalo_l"}}
    assert config.CONFIG["fire"]["conf"] == 0.6


def test_reload_with_a_bad_file_value_applies_nothing(client):
    config.CONFIG_FILE.write_text(json.dumps({"fire": {"conf": 9}, "weapon": {"conf": 0.5}}))
    before = config.CONFIG["weapon"]["conf"]
    assert client.post("/config/reload").status_code == 422
    assert config.CONFIG["weapon"]["conf"] == before


def test_every_default_key_has_an_apply_mode():
    """A new tunable added to DEFAULTS without a mode would be silently
    unchangeable (or crash the validator); fail here instead."""
    for feature, keys in config.DEFAULTS.items():
        for key in keys:
            assert key in config.APPLY[feature], f"{feature}.{key} has no apply mode"
