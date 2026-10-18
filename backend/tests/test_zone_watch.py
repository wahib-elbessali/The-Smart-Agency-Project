"""Restricted camera zones: an alert when someone stands where they may not,
the hand-off that keeps a lost employee known, and the manual fixes."""
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

import app.services.zone_watch as watch_mod
from app.api import zones as zones_api
from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import Alert, AlertStatus, AuditLog, Camera, Employee, RoleName, ZoneRule
from app.services.zone_watch import ZoneWatcher

from .conftest import make_user

T0 = datetime(2026, 10, 18, 9, 0, tzinfo=timezone.utc)
# "Back office": a world zone 0..200 x 0..200 floor units (polygon_m is /100)
ZONES = {
    "Back office": {
        "mode": "world",
        "polygon_m": [[0, 0], [2, 0], [2, 2], [0, 2]],
        "converted_from": {"camera": "cam1"},
    },
    "Hall": {"mode": "pixel", "camera": "cam1", "polygon_px": [[0, 0], [9, 0], [9, 9]]},
}


@pytest.fixture()
def site(db, agency, monkeypatch):
    monkeypatch.setattr(watch_mod, "notify_critical_alerts", lambda ids: None)
    monkeypatch.setattr(watch_mod.alert_state_manager, "broadcast_from_thread", lambda e: None)
    db.add(Camera(agency_id=agency.id, name="cam1", stream_url="rtsp://x/1"))
    sara = Employee(agency_id=agency.id, first_name="Sara", last_name="B", tracking_id="7")
    db.add(sara)
    db.commit()
    return {"agency": agency, "sara": sara}


def rule(db, agency, restriction, zone="Back office"):
    db.add(ZoneRule(agency_id=agency.id, zone_name=zone, restriction=restriction))
    db.commit()


def intrusions(factory):
    with factory() as s:
        return s.query(Alert).filter(Alert.alert_type == "intrusion",
                                     Alert.status != AlertStatus.RESOLVED).all()


def run(watcher, seconds, tracks):
    watcher.tick(now=T0 + timedelta(seconds=seconds), tracks=tracks, zones=ZONES)


def test_a_stranger_in_a_staff_zone_raises_one_alert_after_the_grace(factory, site, db):
    rule(db, site["agency"], "staff")
    w = ZoneWatcher()
    stranger = {"12": {"x": 100.0, "y": 100.0}}
    run(w, 0, stranger)
    run(w, 3, stranger)
    assert intrusions(factory) == []  # still within the 5 s grace
    run(w, 6, stranger)
    run(w, 9, stranger)
    [alert] = intrusions(factory)
    assert alert.title == "Intrusion: Back office"
    assert alert.tracking_id == "12"
    assert alert.camera_id is not None
    assert "reservee au personnel" in alert.message


def test_staff_may_stand_there_and_nobody_zones_flag_everyone(factory, site, db):
    rule(db, site["agency"], "staff")
    w = ZoneWatcher()
    run(w, 0, {"7": {"x": 50.0, "y": 50.0}})
    run(w, 10, {"7": {"x": 50.0, "y": 50.0}})
    assert intrusions(factory) == []

    db.query(ZoneRule).update({"restriction": "nobody"})
    db.commit()
    run(w, 11, {"7": {"x": 50.0, "y": 50.0}})
    run(w, 17, {"7": {"x": 50.0, "y": 50.0}})
    [alert] = intrusions(factory)
    assert "interdite a tous" in alert.message


def test_leaving_before_the_grace_and_outside_the_zone_raise_nothing(factory, site, db):
    rule(db, site["agency"], "staff")
    w = ZoneWatcher()
    run(w, 0, {"12": {"x": 100.0, "y": 100.0}})
    run(w, 3, {"12": {"x": 500.0, "y": 500.0}})  # walked out
    run(w, 6, {"12": {"x": 100.0, "y": 100.0}})  # back: the timer restarts
    run(w, 9, {"12": {"x": 100.0, "y": 100.0}})
    assert intrusions(factory) == []


def test_a_lost_employee_picked_up_again_nearby_stays_staff(factory, site, db):
    rule(db, site["agency"], "staff")
    w = ZoneWatcher()
    run(w, 0, {"7": {"x": 50.0, "y": 50.0}})
    # the tracker lost Sara and found her again 1 s later as track 31
    run(w, 1, {"31": {"x": 70.0, "y": 60.0}})
    run(w, 10, {"31": {"x": 70.0, "y": 60.0}})
    assert intrusions(factory) == []
    with factory() as s:
        assert s.get(Employee, site["sara"].id).tracking_id == "31"


def test_a_new_track_far_away_does_not_inherit_the_employee(factory, site, db):
    w = ZoneWatcher()
    run(w, 0, {"7": {"x": 50.0, "y": 50.0}})
    run(w, 1, {"31": {"x": 900.0, "y": 900.0}})
    with factory() as s:
        assert s.get(Employee, site["sara"].id).tracking_id == "7"


def _client(db, user):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def test_its_staff_links_the_person_and_closes_the_alert(db, roles, site):
    agency = site["agency"]
    alert = Alert(agency_id=agency.id, alert_type="intrusion", tracking_id="12", title="Intrusion: Back office",
                  message="m", severity="CRITICAL", status=AlertStatus.OPEN)
    db.add(alert)
    db.commit()
    guard = make_user(db, roles, RoleName.SECURITY, agency.id, "g@x")
    try:
        body = _client(db, guard).post(f"/api/alerts/{alert.id}/its-staff",
                                       json={"employee_id": site["sara"].id}).json()
    finally:
        app.dependency_overrides.clear()
    assert body["status"] == "RESOLVED"
    assert "fausse alerte: Sara B" in body["message"]
    assert db.get(Employee, site["sara"].id).tracking_id == "12"
    assert db.query(AuditLog).filter_by(action="track_linked").count() == 1


def test_manual_link_moves_a_track_and_not_staff_removes_it(db, roles, site, agency):
    other = Employee(agency_id=agency.id, first_name="Omar", last_name="K", tracking_id="12")
    db.add(other)
    db.commit()
    guard = make_user(db, roles, RoleName.SECURITY, agency.id, "g@x")
    try:
        client = _client(db, guard)
        assert client.put(f"/api/employees/{site['sara'].id}/tracking",
                          json={"tracking_id": "12"}).status_code == 204
        db.expire_all()
        assert db.get(Employee, site["sara"].id).tracking_id == "12"
        assert db.get(Employee, other.id).tracking_id is None  # one person per track
        assert client.delete("/api/employees/tracked/12").status_code == 204
        db.expire_all()
        assert db.get(Employee, site["sara"].id).tracking_id is None
    finally:
        app.dependency_overrides.clear()
    assert {a.action for a in db.query(AuditLog).all()} == {"track_linked", "track_unlinked"}


def test_only_world_zones_can_be_restricted_and_anyone_clears_the_rule(db, roles, site, monkeypatch):
    monkeypatch.setattr(zones_api, "forward", lambda *a, **k: httpx.Response(200, json=ZONES))
    manager = make_user(db, roles, RoleName.MANAGER, site["agency"].id, "m@x")
    try:
        client = _client(db, manager)
        assert client.put("/api/zones/Hall/restriction", json={"restriction": "staff"}).status_code == 422
        saved = client.put("/api/zones/Back office/restriction", json={"restriction": "staff"}).json()
        assert saved["restriction"] == "staff"
        # no badge reader has a badge zone: nobody can ever count as staff
        assert "zone de badge" in saved["warnings"][0]
        listed = {z["name"]: z["restriction"] for z in client.get("/api/zones").json()}
        assert listed == {"Back office": "staff", "Hall": "anyone"}
        client.put("/api/zones/Back office/restriction", json={"restriction": "anyone"})
        assert db.query(ZoneRule).count() == 0
    finally:
        app.dependency_overrides.clear()


def test_the_roster_lets_a_guard_pick_names_from_their_branch_only(db, roles, site):
    from app.models.entities import Agency
    elsewhere = Agency(name="Branch B")
    db.add(elsewhere)
    db.flush()
    db.add(Employee(agency_id=elsewhere.id, first_name="Other", last_name="X"))
    db.commit()
    guard = make_user(db, roles, RoleName.SECURITY, site["agency"].id, "g@x")
    try:
        names = [r["full_name"] for r in _client(db, guard).get("/api/employees/roster").json()]
    finally:
        app.dependency_overrides.clear()
    assert names == ["Sara B"]


def test_resolving_while_they_are_still_there_does_not_reopen_until_they_leave(factory, site, db):
    rule(db, site["agency"], "staff")
    w = ZoneWatcher()
    inside = {"12": {"x": 100.0, "y": 100.0}}
    run(w, 0, inside)
    run(w, 6, inside)
    [alert] = intrusions(factory)
    with factory() as s:  # a guard resolves it; the visitor is still there
        row = s.get(Alert, alert.id)
        row.status, row.resolved_at = AlertStatus.RESOLVED, T0 + timedelta(seconds=8)
        s.commit()
    run(w, 9, inside)
    run(w, 20, inside)
    assert intrusions(factory) == []
    run(w, 21, {"12": {"x": 900.0, "y": 900.0}})  # leaves
    run(w, 30, inside)  # comes back: a new stay
    run(w, 36, inside)
    assert len(intrusions(factory)) == 1


def test_recalibration_redraws_world_zones_from_their_pixels(db, site, monkeypatch):
    from app.services import zone_reproject

    db.add(Camera(agency_id=site["agency"].id, name="cam2", stream_url="rtsp://x/2"))
    db.commit()
    posted = []

    def fake(method, path, **kw):
        if method == "GET":
            return httpx.Response(200, json=ZONES)
        posted.append(kw["json"])
        return httpx.Response(200, json={})
    monkeypatch.setattr(zone_reproject, "forward", fake)
    result = zone_reproject.redraw_world_zones(db)
    assert result == {"redrawn": [], "not_redrawn": ["Back office"]}  # no pixels to redraw from

    ZONES["Back office"]["converted_from"]["polygon_px"] = [[1, 1], [9, 1], [9, 9]]
    try:
        assert zone_reproject.redraw_world_zones(db)["redrawn"] == ["Back office"]
    finally:
        del ZONES["Back office"]["converted_from"]["polygon_px"]
    [body] = posted
    assert body["camera"] == "cam1" and body["polygon"] == [[1, 1], [9, 1], [9, 9]]
    assert set(body["sources"]) == {"cam1", "cam2"}



def test_tracking_down_with_restricted_zones_raises_one_alert_then_clears(factory, site, db, monkeypatch):
    monkeypatch.setattr(watch_mod.settings, "health_down_grace_seconds", 30)
    rule(db, site["agency"], "staff")
    w = ZoneWatcher()

    def blind(seconds):
        w.tick(now=T0 + timedelta(seconds=seconds), tracks={}, zones=ZONES, live=False)

    def down():
        with factory() as s:
            return s.query(Alert).filter(Alert.alert_type == "zone_watch_down",
                                         Alert.status != AlertStatus.RESOLVED).all()
    blind(0)
    blind(20)
    assert down() == []  # a blip pages nobody
    blind(31)
    blind(40)
    [alert] = down()
    assert "Back office" in alert.message
    w.tick(now=T0 + timedelta(seconds=41), tracks={}, zones=ZONES, live=True)
    assert down() == []


def test_an_offboarded_employee_is_not_staff_any_more(factory, site, db):
    rule(db, site["agency"], "staff")
    sara = db.get(Employee, site["sara"].id)
    sara.is_active = False
    db.commit()
    w = ZoneWatcher()
    run(w, 0, {"7": {"x": 50.0, "y": 50.0}})
    run(w, 6, {"7": {"x": 50.0, "y": 50.0}})
    assert len(intrusions(factory)) == 1


def test_offboarding_drops_the_tracking_link(db, site):
    from app.services.offboarding_service import disable_linked_login
    sara = db.get(Employee, site["sara"].id)
    disable_linked_login(db, sara)
    assert sara.tracking_id is None


def test_stale_or_stopped_tracking_leaves_no_ghosts(monkeypatch):
    from app.services import people_tracking
    consumer = people_tracking.PeopleTrackConsumer()
    clock = [100.0]
    monkeypatch.setattr(people_tracking.time, "monotonic", lambda: clock[0])
    consumer.process_message({"type": "tracks", "tracks": [{"id": 3, "x": 1, "y": 2}]})
    assert set(consumer.tracks_snapshot()) == {"3"} and consumer.is_live()
    clock[0] += 10  # the stream went quiet
    assert consumer.tracks_snapshot() == {} and not consumer.is_live()
    consumer.process_message({"type": "tracks", "tracks": [{"id": 3, "x": 1, "y": 2}]})
    consumer.process_message({"type": "state", "phase": "idle"})  # tracking stopped
    assert consumer.tracks_snapshot() == {} and not consumer.is_live()
