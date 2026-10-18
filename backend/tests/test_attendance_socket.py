"""/ws/attendance: who may connect, and that each connection only receives its
own agency's events."""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.security import create_access_token, create_refresh_token
from app.main import app
from app.models.entities import Agency, RoleName
from app.websocket.manager import attendance_manager

from .conftest import make_user


@pytest.fixture()
def world(db, roles, agency):
    other = Agency(name="Branch B")
    db.add(other)
    db.commit()
    return agency, other


def event(agency_id, marker):
    return {"type": "attendance_updated", "agency_id": agency_id, "marker": marker}


def connect(token):
    return TestClient(app).websocket_connect(f"/ws/attendance?token={token}")


def refused(token):
    with pytest.raises(WebSocketDisconnect) as error:
        with connect(token) as socket:
            socket.receive_json()
    return error.value.code


def test_no_token_or_a_bad_token_is_refused(world):
    with pytest.raises(WebSocketDisconnect):
        with TestClient(app).websocket_connect("/ws/attendance") as socket:
            socket.receive_json()
    assert refused("garbage") == 1008


def test_a_refresh_token_is_refused(db, roles, world):
    agency, _ = world
    user = make_user(db, roles, RoleName.MANAGER, agency.id, "m@x")
    assert refused(create_refresh_token(user)) == 1008


@pytest.mark.parametrize("role", [RoleName.AGENT, RoleName.TECHNICIAN])
def test_roles_without_attendance_access_are_refused(db, roles, world, role):
    agency, _ = world
    user = make_user(db, roles, role, agency.id, f"{role.value}@x")
    assert refused(create_access_token(user)) == 1008


def test_a_deactivated_account_is_refused_even_with_a_valid_token(db, roles, world):
    agency, _ = world
    user = make_user(db, roles, RoleName.MANAGER, agency.id, "m@x")
    token = create_access_token(user)
    user.is_active = False
    db.commit()
    assert refused(token) == 1008


def test_a_branchless_manager_is_refused(db, roles, world):
    user = make_user(db, roles, RoleName.MANAGER, None, "m@x")
    assert refused(create_access_token(user)) == 1008


def test_a_manager_only_receives_their_own_branchs_events(db, roles, world):
    agency, other = world
    manager = make_user(db, roles, RoleName.MANAGER, agency.id, "m@x")
    with connect(create_access_token(manager)) as socket:
        attendance_manager.broadcast_from_thread(event(other.id, "theirs"))
        attendance_manager.broadcast_from_thread(event(agency.id, "mine"))
        assert socket.receive_json()["marker"] == "mine"  # theirs was never sent


def test_an_admin_receives_every_branch(db, roles, world):
    agency, other = world
    admin = make_user(db, roles, RoleName.ADMIN, None, "a@x")
    with connect(create_access_token(admin)) as socket:
        attendance_manager.broadcast_from_thread(event(other.id, "b"))
        attendance_manager.broadcast_from_thread(event(agency.id, "a"))
        assert [socket.receive_json()["marker"], socket.receive_json()["marker"]] == ["b", "a"]


def test_a_disconnected_client_is_forgotten(db, roles, world):
    agency, _ = world
    manager = make_user(db, roles, RoleName.SECURITY, agency.id, "s@x")
    with connect(create_access_token(manager)):
        assert len(attendance_manager.connections) == 1
    assert len(attendance_manager.connections) == 0
