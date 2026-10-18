"""Tickets left open at closing time become NO_SHOW (2026-10-18 day test)."""
from datetime import datetime, time, timedelta, timezone

from app.models.entities import Ticket, TicketStatus, Visitor
from app.services.day_close import close_finished_days, last_closing


def test_last_closing_is_today_after_closing_and_yesterday_before():
    closing = time(16, 30)
    local = datetime.now().astimezone().tzinfo
    after = datetime(2026, 10, 19, 17, 0, tzinfo=local)
    before = datetime(2026, 10, 19, 9, 0, tzinfo=local)
    assert last_closing(closing, after) == datetime(2026, 10, 19, 16, 30, tzinfo=local).astimezone(timezone.utc)
    assert last_closing(closing, before) == datetime(2026, 10, 18, 16, 30, tzinfo=local).astimezone(timezone.utc)


def test_unserved_tickets_from_before_closing_become_no_show(db, agency):
    agency.closing_time = time(16, 30)
    local = datetime.now().astimezone().tzinfo
    now = datetime(2026, 10, 19, 17, 0, tzinfo=local)
    visitor = Visitor(agency_id=agency.id, full_name="Karim")
    db.add(visitor)
    db.flush()

    def ticket(number, status, hour):
        t = Ticket(visitor_id=visitor.id, ticket_number=number, status=status,
                   created_at=datetime(2026, 10, 19, hour, 0, tzinfo=local))
        db.add(t)
        return t

    left = ticket("A-1", TicketStatus.WAITING, 12)
    called = ticket("A-2", TicketStatus.CALLED, 15)
    served = ticket("A-3", TicketStatus.COMPLETED, 10)
    late = ticket("A-4", TicketStatus.WAITING, 16)  # 16:00 < 16:30, also closed
    db.commit()

    assert close_finished_days(now) == 3
    assert left.status == called.status == late.status == TicketStatus.NO_SHOW
    assert served.status == TicketStatus.COMPLETED
    assert "Fermeture" in left.notes
    assert close_finished_days(now + timedelta(minutes=1)) == 0
