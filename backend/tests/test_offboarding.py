import pytest

import app.services.offboarding_service as off
from app.models.entities import Counter, Employee, EmployeeStatus, RoleName
from tests.conftest import make_user


class Resp:
    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


@pytest.fixture()
def ai(monkeypatch):
    state = {"gallery": [], "deleted": []}

    def forward(method, path, **kw):
        if method == "GET":
            return Resp([{"name": n} for n in state["gallery"]])
        state["deleted"].append(path)
        return Resp({})

    monkeypatch.setattr(off, "forward", forward)
    monkeypatch.setattr(off, "raise_for_ai_status", lambda r: None)
    return state


def employee(db, agency, first, last, status=EmployeeStatus.ACTIVE, user=None):
    row = Employee(
        agency_id=agency.id,
        first_name=first,
        last_name=last,
        user_id=user.id if user else None,
        status=status,
        is_active=status == EmployeeStatus.ACTIVE,
    )
    db.add(row)
    db.commit()
    return row


def test_name_keys_match_either_order_ignoring_case_and_spacing():
    assert off.name_keys("Sara", "El  Amrani") == off.name_keys("EL AMRANI", "sara")
    assert off.normalise_name("  Sara   El Amrani ") == "sara el amrani"


def test_disable_linked_login_deactivates_user_and_frees_counter(db, roles, agency):
    user = make_user(db, roles, RoleName.AGENT, agency.id, "a@t.com")
    counter = Counter(agency_id=agency.id, name="C1", number=1)
    db.add(counter)
    db.commit()
    user.counter_id = counter.id
    db.commit()
    emp = employee(db, agency, "A", "B", user=user)

    assert off.disable_linked_login(db, emp) is True
    db.commit()
    db.refresh(user)
    assert user.is_active is False and user.counter_id is None


def test_disable_linked_login_without_a_login_is_a_noop(db, agency):
    assert off.disable_linked_login(db, employee(db, agency, "A", "B")) is False


def test_face_removed_by_name_in_either_order(db, agency, ai):
    emp = employee(db, agency, "Sara", "Amrani", status=EmployeeStatus.INACTIVE)
    ai["gallery"] = ["amrani sara", "Someone Else"]
    off.remove_face_for(emp.id, "Sara", "Amrani", None, agency.id)
    assert ai["deleted"] == ["/face/faces/amrani%20sara"]


def test_face_kept_when_an_active_namesake_exists(db, agency, ai):
    leaver = employee(db, agency, "Sara", "Amrani", status=EmployeeStatus.INACTIVE)
    employee(db, agency, "Sara", "Amrani")  # still employed, maybe another branch
    ai["gallery"] = ["Sara Amrani"]
    off.remove_face_for(leaver.id, "Sara", "Amrani", None, agency.id)
    assert ai["deleted"] == []


def test_ai_failure_never_raises(db, agency, monkeypatch):
    def down(*a, **k):
        raise ConnectionError("ai down")

    monkeypatch.setattr(off, "forward", down)
    off.remove_face_for("x", "A", "B", None, agency.id)  # must not raise
