"""Login and token handling: brute-force limits, no account enumeration,
tokens that cannot be abused, and the shipped secret key."""
import logging
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from jose import jwt

from app.api import auth as auth_api
from app.core import config as config_module
from app.core.login_throttle import LoginThrottle, login_throttle
from app.core.security import ALGORITHM, create_access_token, create_refresh_token, hash_password
from app.database.connection import get_db
from app.main import app
from app.models.entities import RoleName, User

from .conftest import make_user


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


# ------------------------------------------------------------- the throttle
def test_the_sixth_failure_in_a_row_is_refused_even_with_the_right_password():
    clock = Clock()
    throttle = LoginThrottle(clock=clock)
    for _ in range(5):
        throttle.check("a@x", "1.1.1.1")
        throttle.failed("a@x", "1.1.1.1")
    with pytest.raises(HTTPException) as error:
        throttle.check("a@x", "1.1.1.1")
    assert error.value.status_code == 429
    assert int(error.value.headers["Retry-After"]) > 0


def test_old_failures_age_out_of_the_window():
    clock = Clock()
    throttle = LoginThrottle(clock=clock)
    for _ in range(5):
        throttle.failed("a@x", "1.1.1.1")
    clock.now += 601
    throttle.check("a@x", "1.1.1.1")  # no longer blocked


def test_a_successful_login_clears_that_accounts_failures():
    throttle = LoginThrottle(clock=Clock())
    for _ in range(4):
        throttle.failed("a@x", "1.1.1.1")
    throttle.succeeded("a@x")
    for _ in range(4):
        throttle.failed("a@x", "1.1.1.1")
    throttle.check("a@x", "1.1.1.1")


def test_one_client_guessing_many_accounts_is_stopped_too():
    throttle = LoginThrottle(clock=Clock())
    for i in range(30):
        throttle.failed(f"user{i}@x", "9.9.9.9")
    with pytest.raises(HTTPException) as error:
        throttle.check("fresh@x", "9.9.9.9")
    assert error.value.status_code == 429
    throttle.check("fresh@x", "8.8.8.8")  # another client is unaffected


def test_other_accounts_are_not_locked_by_one_accounts_failures():
    throttle = LoginThrottle(clock=Clock())
    for _ in range(5):
        throttle.failed("victim@x", "1.1.1.1")
    throttle.check("other@x", "2.2.2.2")


# ------------------------------------------------------------------ the API
@pytest.fixture()
def client(db, roles, agency):
    login_throttle.reset()
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()
    login_throttle.reset()


def _user(db, roles, agency, role=RoleName.AGENT, email="sara@x", active=True):
    user = make_user(db, roles, role, agency.id, email, active=active)
    user.password_hash = hash_password("CorrectHorse1")
    db.commit()
    return user


def login(client, email, password):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def test_repeated_wrong_passwords_lock_the_account_out_until_the_window_passes(client, db, roles, agency):
    _user(db, roles, agency)
    codes = [login(client, "sara@x.com", "wrong").status_code for _ in range(5)]
    assert codes == [401] * 5
    locked = login(client, "sara@x.com", "CorrectHorse1")
    assert locked.status_code == 429
    assert "Retry-After" in locked.headers


def test_a_wrong_email_costs_a_password_check_like_a_wrong_password(client, db, roles, agency, monkeypatch):
    _user(db, roles, agency, email="sara@x.com")
    checks = []
    real = auth_api.verify_password
    monkeypatch.setattr(auth_api, "verify_password", lambda p, h: (checks.append(h), real(p, h))[1])

    login(client, "nobody@x.com", "whatever1")
    login(client, "sara@x.com", "whatever1")

    assert len(checks) == 2  # the unknown email was hashed against too
    assert checks[0] == auth_api._DUMMY_HASH


def test_both_failures_answer_identically(client, db, roles, agency):
    _user(db, roles, agency, email="sara@x.com")
    unknown = login(client, "nobody@x.com", "whatever1")
    wrong = login(client, "sara@x.com", "whatever1")
    assert (unknown.status_code, unknown.json()) == (wrong.status_code, wrong.json())


def test_public_registration_cannot_pick_a_branch(client, agency):
    response = client.post(
        "/api/auth/register",
        json={"full_name": "Mallory", "email": "mallory@x.com", "password": "Password123", "agency_id": agency.id},
    )
    assert response.status_code == 403


def test_public_registration_makes_a_branchless_agent(client, db, roles):
    response = client.post(
        "/api/auth/register",
        json={"full_name": "New Person", "email": "new@x.com", "password": "Password123"},
    )
    assert response.status_code == 201
    assert response.json()["role"] == "AGENT"
    assert response.json()["agency_id"] is None


# ------------------------------------------------------------------- tokens
def _forged(user, **claims):
    payload = {"sub": user.id, "role": "ADMIN", "type": "access",
               "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=5), **claims}
    return jwt.encode(payload, config_module.settings.secret_key, algorithm=ALGORITHM)


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_the_role_inside_a_token_is_ignored(client, db, roles, agency):
    agent = _user(db, roles, agency)
    token = _forged(agent, role="ADMIN")  # an agent's token claiming to be admin
    assert client.get("/api/users", headers=bearer(token)).status_code == 403


def test_an_expired_token_is_refused(client, db, roles, agency):
    agent = _user(db, roles, agency)
    token = _forged(agent, exp=datetime.now(timezone.utc) - timedelta(seconds=1))
    assert client.get("/api/auth/me", headers=bearer(token)).status_code == 401


def test_a_refresh_token_cannot_be_used_as_an_access_token(client, db, roles, agency):
    agent = _user(db, roles, agency)
    assert client.get("/api/auth/me", headers=bearer(create_refresh_token(agent))).status_code == 401


def test_an_access_token_cannot_be_used_to_refresh(client, db, roles, agency):
    agent = _user(db, roles, agency)
    response = client.post("/api/auth/refresh", json={"refresh_token": create_access_token(agent)})
    assert response.status_code == 401


def test_a_token_signed_with_another_key_is_refused(client, db, roles, agency):
    agent = _user(db, roles, agency)
    token = jwt.encode({"sub": agent.id, "type": "access",
                        "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}, "not-the-key", algorithm=ALGORITHM)
    assert client.get("/api/auth/me", headers=bearer(token)).status_code == 401


def test_a_token_with_no_signature_is_refused(client, db, roles, agency):
    agent = _user(db, roles, agency)
    header = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0"  # {"alg":"none","typ":"JWT"}
    import base64, json
    body = base64.urlsafe_b64encode(json.dumps({"sub": agent.id, "type": "access"}).encode()).rstrip(b"=").decode()
    assert client.get("/api/auth/me", headers=bearer(f"{header}.{body}.")).status_code == 401


def test_deactivating_an_account_kills_its_existing_tokens(client, db, roles, agency):
    agent = _user(db, roles, agency)
    token = create_access_token(agent)
    assert client.get("/api/auth/me", headers=bearer(token)).status_code == 200
    agent.is_active = False
    db.commit()
    assert client.get("/api/auth/me", headers=bearer(token)).status_code == 401
    refresh = create_refresh_token(agent)
    assert client.post("/api/auth/refresh", json={"refresh_token": refresh}).status_code == 401


# --------------------------------------------------------------- secret key
def test_the_default_secret_refuses_to_start_in_production():
    with pytest.raises(RuntimeError):
        config_module.check_secret_key(SimpleNamespace(secret_key=config_module.DEFAULT_SECRET_KEY, app_env="production"))


def test_the_default_secret_is_only_a_warning_in_development(caplog):
    with caplog.at_level(logging.WARNING):
        config_module.check_secret_key(SimpleNamespace(secret_key=config_module.DEFAULT_SECRET_KEY, app_env="development"))
    assert "forge login tokens" in caplog.text


def test_a_real_secret_passes_quietly(caplog):
    with caplog.at_level(logging.WARNING):
        config_module.check_secret_key(SimpleNamespace(secret_key="x" * 40, app_env="production"))
    assert caplog.text == ""
