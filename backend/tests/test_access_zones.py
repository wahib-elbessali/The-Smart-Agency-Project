"""Door access zones (app/api/access_zones.py): a branch can manage its rooms
after creation, and deleting one takes everyone's access to it along."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import Agency, Employee, RoleName, Zone

from .conftest import make_user


@pytest.fixture()
def api(db, roles, agency):
    db.execute(text("PRAGMA foreign_keys=ON"))
    admin = make_user(db, roles, RoleName.ADMIN, None, "admin@x")
    app.dependency_overrides[get_current_user] = lambda: admin
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_create_list_rename_delete(api, agency):
    created = api.post(f"/api/agencies/{agency.id}/access-zones", json={"name": "  Coffre  ", "is_private": True})
    assert created.status_code == 201
    zone = created.json()
    assert zone["name"] == "Coffre" and zone["is_private"] is True and zone["zone_type"] == "PUBLIC"

    listed = api.get(f"/api/agencies/{agency.id}/access-zones").json()
    assert [z["name"] for z in listed] == ["Coffre"]

    renamed = api.put(f"/api/access-zones/{zone['id']}", json={"name": "Salle forte"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Salle forte" and renamed.json()["is_private"] is True

    assert api.delete(f"/api/access-zones/{zone['id']}").status_code == 204
    assert api.get(f"/api/agencies/{agency.id}/access-zones").json() == []


def test_names_are_unique_per_branch_ignoring_case(api, db, agency):
    other = Agency(name="Other branch")
    db.add(other)
    db.commit()
    assert api.post(f"/api/agencies/{agency.id}/access-zones", json={"name": "Accueil"}).status_code == 201
    assert api.post(f"/api/agencies/{agency.id}/access-zones", json={"name": "accueil"}).status_code == 409
    # Same name at another branch is fine.
    assert api.post(f"/api/agencies/{other.id}/access-zones", json={"name": "Accueil"}).status_code == 201


def test_rename_to_a_taken_name_conflicts(api, agency):
    a = api.post(f"/api/agencies/{agency.id}/access-zones", json={"name": "Accueil"}).json()
    api.post(f"/api/agencies/{agency.id}/access-zones", json={"name": "Coffre"})
    assert api.put(f"/api/access-zones/{a['id']}", json={"name": "COFFRE"}).status_code == 409
    # Renaming to its own name (case change) is not a conflict with itself.
    assert api.put(f"/api/access-zones/{a['id']}", json={"name": "ACCUEIL"}).status_code == 200


def test_null_fields_are_refused(api, agency):
    zone = api.post(f"/api/agencies/{agency.id}/access-zones", json={"name": "Accueil"}).json()
    assert api.put(f"/api/access-zones/{zone['id']}", json={"is_private": None}).status_code == 422


def test_deleting_a_zone_revokes_access_but_keeps_the_employee(api, db, agency):
    zone = Zone(agency_id=agency.id, name="Coffre")
    employee = Employee(agency_id=agency.id, first_name="Sara", last_name="B", authorized_zones=[zone])
    db.add_all([zone, employee])
    db.commit()

    assert api.delete(f"/api/access-zones/{zone.id}").status_code == 204
    db.expire_all()
    assert db.get(Employee, employee.id) is not None
    assert db.get(Employee, employee.id).authorized_zones == []


def test_unknown_ids_are_404(api, agency):
    assert api.get("/api/agencies/nope/access-zones").status_code == 404
    assert api.put("/api/access-zones/nope", json={"name": "Xx"}).status_code == 404
    assert api.delete("/api/access-zones/nope").status_code == 404
