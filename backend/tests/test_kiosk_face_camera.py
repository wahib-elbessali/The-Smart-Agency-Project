"""The kiosk face camera: validated on the agency, used for the wanted-alert
link (2026-10-18 day test: face detections moved to a kiosk camera, and the
link only looked at the kiosk zone's overhead camera)."""
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import (Agency, Alert, AlertSeverity, AlertStatus, Camera, RoleName, Ticket,
                                 TicketStatus, Visitor)
from app.services import people_tracking

from .conftest import make_user


def test_face_camera_must_belong_to_the_agency(db, roles, agency):
    other = Agency(name="Other")
    db.add(other)
    db.flush()
    mine = Camera(agency_id=agency.id, name="kiosk", stream_url="rtsp://x/1")
    theirs = Camera(agency_id=other.id, name="far", stream_url="rtsp://x/2")
    db.add_all([mine, theirs])
    db.commit()
    app.dependency_overrides[get_db] = lambda: db
    admin = make_user(db, roles, RoleName.ADMIN, None, "a@x")
    app.dependency_overrides[get_current_user] = lambda: admin
    try:
        client = TestClient(app)
        assert client.put(f"/api/agencies/{agency.id}", json={"kiosk_face_camera_id": theirs.id}).status_code == 422
        ok = client.put(f"/api/agencies/{agency.id}", json={"kiosk_face_camera_id": mine.id})
        assert ok.status_code == 200 and ok.json()["kiosk_face_camera_id"] == mine.id
    finally:
        app.dependency_overrides.clear()


def test_wanted_alert_on_the_face_camera_links_to_the_ticket(db, agency, monkeypatch):
    overhead = Camera(agency_id=agency.id, name="cam1", stream_url="rtsp://x/1")
    kiosk = Camera(agency_id=agency.id, name="cam3", stream_url="rtsp://x/3")
    db.add_all([overhead, kiosk])
    db.flush()
    agency.kiosk_face_camera_id = kiosk.id
    visitor = Visitor(agency_id=agency.id, full_name="Visiteur borne")
    db.add(visitor)
    db.flush()
    now = datetime.now(timezone.utc)
    alert = Alert(agency_id=agency.id, camera_id=kiosk.id, alert_type="wanted", title="t", message="m",
                  severity=AlertSeverity.CRITICAL, status=AlertStatus.OPEN, created_at=now - timedelta(seconds=10))
    ticket = Ticket(visitor_id=visitor.id, ticket_number="X-1", status=TicketStatus.WAITING, created_at=now)
    db.add_all([alert, ticket])
    db.commit()
    monkeypatch.setattr(people_tracking, "camera_id_by_name",
                        lambda db_, name: overhead.id if name == "cam1" else None)

    people_tracking._link_wanted_alert(db, ticket, {"mode": "world", "converted_from": {"camera": "cam1"}})
    assert alert.ticket_id == ticket.id
