"""/api/ai/config: ADMIN-only proxy to the AI service's live config API."""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.api import ai_config
from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import AIAlertThreshold, AuditLog, RoleName

from .conftest import make_user

AI_CONFIG = {
    "config": {"weapon": {"conf": 0.25}},
    "apply_modes": {"weapon": {"conf": "live"}},
    "startup_config": {"weapon": {"conf": 0.25}},
    "pending_restart": {},
    "config_file": "C:/ai/config.json",
    "data_dir": "C:/ai/data",
    "models_dir": "C:/ai/models",
}


class FakeAI:
    """Stands in for forward(): records calls, answers from `responses`."""

    def __init__(self):
        self.calls = []
        self.responses = {}

    def __call__(self, method, path, json=None, **_):
        self.calls.append((method, path, json))
        status, body = self.responses.get((method, path), (200, {}))
        return httpx.Response(status, json=body)


@pytest.fixture()
def ai(monkeypatch):
    fake = FakeAI()
    monkeypatch.setattr(ai_config, "forward", fake)
    return fake


@pytest.fixture()
def as_user(db, roles, agency):
    """Returns a function that makes the app see a user with the given role."""
    users = {}

    def pick(role):
        if role not in users:
            users[role] = make_user(
                db, roles, role, None if role == RoleName.ADMIN else agency.id, f"{role.value}@x"
            )
        app.dependency_overrides[get_current_user] = lambda: users[role]
        return users[role]

    app.dependency_overrides[get_db] = lambda: db
    yield pick
    app.dependency_overrides.clear()


@pytest.fixture()
def client():
    return TestClient(app)


def test_get_returns_the_ai_config_without_its_server_paths(client, ai, as_user):
    as_user(RoleName.ADMIN)
    ai.responses[("GET", "/config")] = (200, AI_CONFIG)
    body = client.get("/api/ai/config").json()
    assert body["config"] == AI_CONFIG["config"]
    assert body["apply_modes"] == AI_CONFIG["apply_modes"]
    assert not {"config_file", "data_dir", "models_dir"} & body.keys()


@pytest.mark.parametrize("role", [RoleName.MANAGER, RoleName.SECURITY, RoleName.AGENT, RoleName.TECHNICIAN])
def test_only_admin_can_read_or_change(client, ai, as_user, role):
    as_user(role)
    assert client.get("/api/ai/config").status_code == 403
    assert client.patch("/api/ai/config", json={"changes": {"weapon": {"conf": 0.4}}}).status_code == 403
    assert client.post("/api/ai/config/reload").status_code == 403
    assert ai.calls == []


def test_patch_forwards_changes_and_audits_them(client, ai, as_user, db):
    admin = as_user(RoleName.ADMIN)
    ai.responses[("PATCH", "/config")] = (
        200,
        {"applied": {"weapon": {"conf": {"value": 0.4, "mode": "live"}}},
         "pending_restart": {}, "previous": {"weapon": {"conf": 0.25}}, "persisted": False},
    )
    response = client.patch("/api/ai/config", json={"changes": {"weapon": {"conf": 0.4}}})

    assert response.status_code == 200
    assert response.json()["applied"]["weapon"]["conf"]["value"] == 0.4
    assert ai.calls == [("PATCH", "/config", {"changes": {"weapon": {"conf": 0.4}}, "persist": False})]
    entry = db.query(AuditLog).one()
    assert (entry.action, entry.user_id) == ("ai_config_changed", admin.id)
    assert entry.details["changes"] == {"weapon": {"conf": 0.4}}
    assert entry.details["previous"] == {"weapon": {"conf": 0.25}}


def test_threshold_keys_are_stored_so_they_survive_an_ai_restart(client, ai, as_user, db):
    as_user(RoleName.ADMIN)
    ai.responses[("PATCH", "/config")] = (200, {"applied": {}, "pending_restart": {}, "previous": {}, "persisted": False})

    client.patch(
        "/api/ai/config",
        json={"changes": {"weapon": {"conf": 0.7, "imgsz": 800}, "fire": {"conf": 0.5}, "wanted": {"threshold": 0.6}}},
    )

    stored = {r.alert_type: r.confidence for r in db.query(AIAlertThreshold).all()}
    assert stored == {"weapon": 0.7, "fire": 0.5, "wanted": 0.6}


def test_other_keys_are_not_stored(client, ai, as_user, db):
    as_user(RoleName.ADMIN)
    ai.responses[("PATCH", "/config")] = (200, {"applied": {}, "pending_restart": {}, "previous": {}, "persisted": False})
    client.patch("/api/ai/config", json={"changes": {"weapon": {"imgsz": 800}, "fire": {"update_interval": 3.0}}})
    assert db.query(AIAlertThreshold).count() == 0


def test_validation_errors_reach_the_caller_and_nothing_is_audited(client, ai, as_user, db):
    as_user(RoleName.ADMIN)
    detail = {"message": "config not changed", "errors": ["fire.imgsz must be in [32, 4096], got 7"]}
    ai.responses[("PATCH", "/config")] = (422, {"detail": detail})

    response = client.patch("/api/ai/config", json={"changes": {"fire": {"imgsz": 7}}})

    assert response.status_code == 422
    assert response.json()["detail"] == detail
    assert db.query(AuditLog).count() == 0
    assert db.query(AIAlertThreshold).count() == 0


def test_persist_flag_is_forwarded(client, ai, as_user):
    as_user(RoleName.ADMIN)
    ai.responses[("PATCH", "/config")] = (200, {"applied": {}, "pending_restart": {}, "previous": {}, "persisted": True})
    client.patch("/api/ai/config", json={"changes": {"face": {"pack": "buffalo_l"}}, "persist": True})
    assert ai.calls[0][2]["persist"] is True


def test_reload_is_audited(client, ai, as_user, db):
    as_user(RoleName.ADMIN)
    ai.responses[("POST", "/config/reload")] = (200, {"applied": {"fire": {"conf": {"value": 0.6, "mode": "live"}}}})
    assert client.post("/api/ai/config/reload").status_code == 200
    assert db.query(AuditLog).one().action == "ai_config_reloaded"


def test_body_must_have_changes(client, ai, as_user):
    as_user(RoleName.ADMIN)
    assert client.patch("/api/ai/config", json={"persist": True}).status_code == 422
    assert ai.calls == []
