"""One AI service serves every branch; one branch's manager must not change
another branch's AI configuration, and gallery changes are audit-logged
(2026-10-18 comparison with master)."""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.api import calibration, face, people, watchlist
from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import Agency, AuditLog, Camera, GalleryEntry, RoleName

from .conftest import make_user


@pytest.fixture()
def site(db, roles, agency):
    other = Agency(name="Branch B")
    db.add(other)
    db.flush()
    mine = Camera(agency_id=agency.id, name="cam-a", stream_url="rtsp://x/a")
    theirs = Camera(agency_id=other.id, name="cam-b", stream_url="rtsp://x/b")
    db.add_all([mine, theirs])
    db.commit()
    manager = make_user(db, roles, RoleName.MANAGER, agency.id, "m@x")
    admin = make_user(db, roles, RoleName.ADMIN, None, "a@x")
    yield {"agency": agency, "other": other, "mine": mine, "theirs": theirs,
           "manager": manager, "admin": admin}
    app.dependency_overrides.clear()


def as_user(db, user):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def ai(monkeypatch, module, answers):
    calls = []

    def fake(method, path, **kw):
        calls.append((method, path, kw.get("json")))
        body = answers.get((method, path), {})
        return httpx.Response(200, json=body)
    monkeypatch.setattr(module, "forward", fake)
    return calls


def test_a_manager_cannot_calibrate_another_branchs_camera(db, site, monkeypatch):
    calls = ai(monkeypatch, calibration, {
        ("GET", "/calibration"): {"cam-a": {"diagnostics": {}}, "cam-b": {"diagnostics": {}}},
    })
    monkeypatch.setattr(calibration, "redraw_world_zones", lambda db: {})
    client = as_user(db, site["manager"])
    body = {"camera_id": site["theirs"].id, "points": [[0, 0]] * 4, "img_w": 1, "img_h": 1}
    assert client.post("/api/calibration/rect", json=body).status_code == 403
    assert client.delete(f"/api/calibration/{site['theirs'].id}").status_code == 403
    assert client.post("/api/calibration/align",
                       json={"points": [{site["theirs"].id: [1, 1]}]}).status_code == 403
    # only their own branch's calibration is listed
    assert [c["camera_id"] for c in client.get("/api/calibration").json()] == [site["mine"].id]
    assert all(c[0] == "GET" for c in calls)  # nothing reached the AI service
    body["camera_id"] = site["mine"].id
    assert client.post("/api/calibration/rect", json=body).status_code == 200


def test_a_managers_gate_change_keeps_the_other_branchs_gates(db, site, monkeypatch):
    others = {"camera": "cam-b", "points": [[1, 1], [2, 2]]}
    calls = ai(monkeypatch, calibration, {
        ("GET", "/calibration/gates"): {"gates": [others, {"camera": "cam-a", "points": [[0, 0], [1, 0]]}]},
        ("POST", "/calibration/gates"): {"gates": []},
    })
    client = as_user(db, site["manager"])
    assert client.get("/api/calibration/gates").json() == [{"camera": "cam-a", "points": [[0, 0], [1, 0]]}]
    client.post("/api/calibration/gates",
                json={"gates": [{"camera": site["mine"].id, "points": [[5, 5], [6, 6]]}]})
    client.delete("/api/calibration/gates")
    posted = [c[2]["gates"] for c in calls if c[0] == "POST"]
    assert posted[0] == [others, {"camera": "cam-a", "points": [[5, 5], [6, 6]]}]
    assert posted[1] == [others]  # "clear" only cleared their own


def test_people_sources_are_per_branch(db, site, monkeypatch):
    ai(monkeypatch, people, {("GET", "/people/sources"): {"sources_known": ["cam-a", "cam-b"]}})
    client = as_user(db, site["manager"])
    assert client.get("/api/people/sources").json()["sources_known"] == [site["mine"].id]
    assert client.post("/api/people/sources",
                       json={"camera_ids": [site["theirs"].id]}).status_code == 403
    assert client.delete(f"/api/people/sources/{site['theirs'].id}").status_code == 403


def test_the_watchlist_is_per_branch_and_audited(db, site, monkeypatch):
    gallery = [{"name": "THEIRS"}, {"name": "OLD"}]
    ai(monkeypatch, watchlist, {("GET", "/wanted/watchlist"): gallery})
    db.add(GalleryEntry(kind="watchlist", name="THEIRS", agency_id=site["other"].id))
    db.commit()
    manager = as_user(db, site["manager"])
    # OLD has no owner (from before), so on a multi-branch site a manager does
    # not see it; THEIRS belongs to the other branch
    assert manager.get("/api/watchlist").json() == []
    added = manager.post("/api/watchlist", data={"name": "MINE"},
                         files={"image": ("a.jpg", b"x", "image/jpeg")})
    assert added.status_code == 200  # a new name is free to take
    gallery.append({"name": "MINE"})
    assert [e["name"] for e in manager.get("/api/watchlist").json()] == ["MINE"]
    assert manager.delete("/api/watchlist/THEIRS").status_code == 403
    assert manager.delete("/api/watchlist/OLD").status_code == 403
    assert manager.put("/api/watchlist/threshold", json={"threshold": 0.5}).status_code == 403
    assert manager.delete("/api/watchlist/MINE").status_code == 204

    admin = as_user(db, site["admin"])
    assert {e["name"] for e in admin.get("/api/watchlist").json()} == {"MINE", "THEIRS", "OLD"}
    actions = [(a.action, a.details["name"]) for a in db.query(AuditLog).all()]
    assert actions == [("watchlist_added", "MINE"), ("watchlist_removed", "MINE")]


def test_on_a_single_branch_site_old_entries_are_the_managers(db, site, monkeypatch):
    db.delete(site["theirs"])
    db.delete(site["other"])
    db.commit()
    ai(monkeypatch, face, {("GET", "/face/faces"): [{"name": "Sara B", "embeddings": [[0]]}]})
    manager = as_user(db, site["manager"])
    assert [f["name"] for f in manager.get("/api/face/faces").json()] == ["Sara B"]
    assert manager.delete("/api/face/faces/Sara B").status_code == 204
    assert db.query(AuditLog).filter_by(action="face_removed").count() == 1


def test_faces_of_another_branch_are_hidden_and_protected(db, site, monkeypatch):
    ai(monkeypatch, face, {("GET", "/face/faces"): [
        {"name": "Ours", "embeddings": []}, {"name": "Theirs", "embeddings": []}]})
    db.add_all([GalleryEntry(kind="face", name="Ours", agency_id=site["agency"].id),
                GalleryEntry(kind="face", name="Theirs", agency_id=site["other"].id)])
    db.commit()
    manager = as_user(db, site["manager"])
    assert [f["name"] for f in manager.get("/api/face/faces").json()] == ["Ours"]
    assert manager.delete("/api/face/faces/Theirs").status_code == 403
    assert manager.post("/api/face/enroll", data={"name": "Theirs"},
                        files={"image": ("a.jpg", b"x", "image/jpeg")}).status_code == 403
