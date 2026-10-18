"""The agent sees a returning visitor's earlier visits (2026-10-18 day test)."""
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.core.security import get_current_user
from app.database.connection import get_db
from app.main import app
from app.models.entities import RoleName, Ticket, TicketStatus, Visitor

from .conftest import make_user

FACE = [1.0] + [0.0] * 511
OTHER = [0.0, 1.0] + [0.0] * 510


def test_history_finds_earlier_visits_by_face(db, roles, agency):
    t0 = datetime(2026, 10, 19, 8, 30, tzinfo=timezone.utc)
    morning = Visitor(agency_id=agency.id, full_name="Visiteur borne", face_embedding=FACE, created_at=t0)
    stranger = Visitor(agency_id=agency.id, full_name="Visiteur borne", face_embedding=OTHER, created_at=t0)
    later = Visitor(agency_id=agency.id, full_name="Visiteur borne", face_embedding=FACE,
                    created_at=t0 + timedelta(hours=4))
    nofaces = Visitor(agency_id=agency.id, full_name="Visiteur borne", created_at=t0 + timedelta(hours=5))
    db.add_all([morning, stranger, later, nofaces])
    db.flush()
    db.add_all([
        Ticket(visitor_id=morning.id, ticket_number="VIR-001", status=TicketStatus.COMPLETED, notes="RIB demande"),
        Ticket(visitor_id=stranger.id, ticket_number="VIR-002", status=TicketStatus.COMPLETED),
    ])
    now_ticket = Ticket(visitor_id=later.id, ticket_number="VIR-011", status=TicketStatus.CALLED)
    blind_ticket = Ticket(visitor_id=nofaces.id, ticket_number="VIR-012", status=TicketStatus.CALLED)
    db.add_all([now_ticket, blind_ticket])
    db.commit()
    agent = make_user(db, roles, RoleName.AGENT, agency.id, "ag@x")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: agent
    try:
        client = TestClient(app)
        body = client.get(f"/api/tickets/{now_ticket.id}/history").json()
        assert body["recognised"] is True
        assert [v["ticket_number"] for v in body["previous_visits"]] == ["VIR-001"]
        assert body["previous_visits"][0]["notes"] == "RIB demande"
        assert client.get(f"/api/tickets/{blind_ticket.id}/history").json() == {
            "recognised": False, "previous_visits": []}
    finally:
        app.dependency_overrides.clear()
