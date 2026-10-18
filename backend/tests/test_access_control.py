"""Access control, checked against every route the app actually registers, so a
new route cannot ship without being covered:

* no token -> 401 (except the few deliberately public routes);
* a role the route does not allow -> 403;
* a non-admin asking for another branch's data through an `agency_id` -> 403.
"""
import re

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import Agency, RoleName, User

from .conftest import make_user

ZERO = "00000000-0000-0000-0000-000000000000"

# Routes that are public on purpose, or authenticate some other way.
PUBLIC = {
    ("POST", "/api/auth/register"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/refresh"),
    ("GET", "/health"),
}
# The device-facing router authenticates with a device key, not a user token.
DEVICE_KEY_PREFIX = "/internal"


def _flat(routes, prefix=""):
    for route in routes:
        if hasattr(route, "original_router"):
            yield from _flat(route.original_router.routes, prefix + (route.include_context.prefix or ""))
        else:
            yield prefix, route


def _roles(route):
    """The roles a route restricts itself to, or None if any signed-in user may call it."""
    found = []

    def walk(dep):
        call = dep.call
        if getattr(call, "__name__", "") == "role_dependency":
            for cell in call.__closure__ or []:
                try:
                    value = cell.cell_contents
                except ValueError:
                    continue
                if isinstance(value, tuple):
                    found.extend(value)
        for sub in dep.dependencies:
            walk(sub)

    walk(route.dependant)
    return set(found) or None


def _routes():
    out = []
    for prefix, route in _flat(app.routes):
        if not isinstance(route, APIRoute):
            continue
        path = prefix + route.path
        if path.startswith(("/docs", "/redoc", "/openapi")):
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            out.append((method, path, _roles(route)))
    return out


ROUTES = _routes()
USER_ROUTES = [r for r in ROUTES if (r[0], r[1]) not in PUBLIC and not r[1].startswith(DEVICE_KEY_PREFIX)]
ROLE_RESTRICTED = [r for r in USER_ROUTES if r[2]]
SCOPED = [
    r for r in ROLE_RESTRICTED
    if "{agency_id}" in r[1] and r[0] in ("GET", "DELETE") and (r[2] - {RoleName.ADMIN})
]


# Required query parameters, so validation does not answer 422 before the
# branch check is reached.
REQUIRED_QUERY = {"/api/agencies/{agency_id}/report": {"start": "2026-01-01", "end": "2026-01-02"}}


def _url(path, agency_id=ZERO):
    return re.sub(r"\{agency_id\}", agency_id, re.sub(r"\{(?!agency_id)[^}]+\}", ZERO, path))


def _id(method, path):
    return f"{method} {path}"


@pytest.fixture()
def client(db, roles, agency):
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_the_route_scan_found_the_app(client):
    assert len(USER_ROUTES) > 100
    assert len(ROLE_RESTRICTED) > 80
    assert SCOPED


@pytest.mark.parametrize("method,path,_", USER_ROUTES, ids=[_id(m, p) for m, p, _ in USER_ROUTES])
def test_no_token_is_401(client, method, path, _):
    response = client.request(method, _url(path), json={} if method in ("POST", "PUT", "PATCH") else None)
    assert response.status_code == 401, response.text


@pytest.mark.parametrize("method,path,_", ROLE_RESTRICTED, ids=[_id(m, p) for m, p, _ in ROLE_RESTRICTED])
def test_a_role_the_route_does_not_allow_is_403(client, db, roles, agency, method, path, _):
    allowed = _
    refused = [role for role in RoleName if role not in allowed]
    for role in refused:
        user = make_user(db, roles, role, None if role == RoleName.ADMIN else agency.id, f"{role.value}@acl")
        app.dependency_overrides[get_current_user] = lambda uid=user.id: db.get(User, uid)
        response = client.request(
            method, _url(path, agency.id), json={} if method in ("POST", "PUT", "PATCH") else None
        )
        assert response.status_code == 403, f"{role.value}: {response.status_code} {response.text}"


@pytest.mark.parametrize("method,path,_", SCOPED, ids=[_id(m, p) for m, p, _ in SCOPED])
def test_another_branchs_agency_id_is_403(client, db, roles, agency, method, path, _):
    other = Agency(name="Branch B")
    db.add(other)
    db.commit()
    for role in sorted(_ - {RoleName.ADMIN}, key=lambda r: r.value):
        user = make_user(db, roles, role, agency.id, f"{role.value}@scope")
        app.dependency_overrides[get_current_user] = lambda uid=user.id: db.get(User, uid)
        response = client.request(method, _url(path, other.id), params=REQUIRED_QUERY.get(path))
        assert response.status_code == 403, f"{role.value}: {response.status_code} {response.text}"


@pytest.mark.parametrize(
    "method,path",
    [(m, p) for m, p, _ in ROUTES if p.startswith(DEVICE_KEY_PREFIX)],
)
def test_device_routes_refuse_a_request_with_no_device_key(client, method, path):
    response = client.request(method, _url(path), json={})
    assert response.status_code in (401, 403, 422), response.text
    assert response.status_code != 200


# ---------------------------------------------------------------------------
# The tests above take each route's allowed roles from the code, so a route
# that lost its role check would simply drop out of them. The contract is the
# independent statement of who may call what; hold the code to it.
def _contract_roles():
    from pathlib import Path

    text = (Path(__file__).resolve().parents[2] / "contracts" / "api.md").read_text(encoding="utf-8")
    out = {}
    for block in re.split(r"(?m)^(?=### )", text):
        head = re.match(r"### (GET|POST|PUT|PATCH|DELETE) ([^\s?]+)", block)
        roles = re.search(r"\*\*Roles:\*\*([^\n]*)", block)
        if not head or not roles:
            continue
        line = roles.group(1)
        if "Public" in line:
            wanted = "public"
        elif "any authenticated" in line:
            wanted = set()
        else:
            wanted = {RoleName[name] for name in re.findall(r"\b(ADMIN|MANAGER|AGENT|SECURITY|TECHNICIAN)\b", line)}
        out[(head.group(1), re.sub(r"\{[^}]+\}", "{x}", head.group(2)))] = wanted
    return out


def test_every_route_restricts_itself_to_the_roles_the_contract_lists():
    contract = _contract_roles()
    mismatches = []
    for method, path, roles in ROUTES:
        key = (method, re.sub(r"\{[^}]+\}", "{x}", path))
        wanted = contract.get(key)
        if wanted is None or wanted == "public":
            continue
        if set(roles or ()) != wanted:
            mismatches.append(f"{method} {path}: contract {sorted(r.value for r in wanted)}, "
                              f"code {sorted(r.value for r in roles or ())}")
    assert not mismatches, "\n".join(mismatches)


def test_the_contract_covers_every_route():
    contract = _contract_roles()
    missing = [
        f"{m} {p}" for m, p, _ in ROUTES
        if (m, re.sub(r"\{[^}]+\}", "{x}", p)) not in contract and not p.startswith(DEVICE_KEY_PREFIX)
    ]
    assert not missing, missing
