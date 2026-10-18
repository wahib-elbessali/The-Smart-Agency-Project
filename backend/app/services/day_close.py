"""Closing the day's queue.

A ticket still WAITING or CALLED when its branch closes was never going to
be served - the visitor went home. Nothing used to close it, so it sat in the
queue into the next morning (2026-10-18 day test: a visitor who left at
12:39 was still "waiting" after closing, and would have been first in line
the next day). Once a branch's closing time has passed, every ticket it
created before that moment and left WAITING or CALLED becomes NO_SHOW.

Closing time is a wall-clock time with no timezone, read in this machine's
local time: the deployed system runs on one local machine at the branch
(a project rule), so the machine's clock is the branch's clock. Run from the
health-monitor thread about once a minute; catching up after downtime is
the same query, so a backend that was off at closing time closes the day
when it comes back.
"""

import logging
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select

from app.database.connection import SessionLocal
from app.models.entities import Agency, Ticket, TicketStatus, Visitor

logger = logging.getLogger(__name__)

OPEN_STATUSES = (TicketStatus.WAITING, TicketStatus.CALLED)


def last_closing(closing: time, now: datetime) -> datetime:
    """The most recent closing moment at or before `now`, in UTC."""
    local_now = now.astimezone()
    today = datetime.combine(local_now.date(), closing, tzinfo=local_now.tzinfo)
    moment = today if local_now >= today else today - timedelta(days=1)
    return moment.astimezone(timezone.utc)


def close_finished_days(now: datetime | None = None) -> int:
    """Mark NO_SHOW every open ticket created before its branch's last closing.
    Returns how many tickets it closed. Never raises."""
    now = now or datetime.now(timezone.utc)
    db = SessionLocal()
    try:
        closed = 0
        agencies = db.scalars(select(Agency).where(Agency.closing_time.is_not(None))).all()
        for agency in agencies:
            cutoff = last_closing(agency.closing_time, now)
            tickets = db.scalars(
                select(Ticket)
                .join(Visitor, Visitor.id == Ticket.visitor_id)
                .where(
                    Visitor.agency_id == agency.id,
                    Ticket.status.in_(OPEN_STATUSES),
                    Ticket.created_at < cutoff,
                )
            ).all()
            for ticket in tickets:
                ticket.status = TicketStatus.NO_SHOW
                ticket.notes = ticket.notes or "Fermeture de l'agence: ticket non servi"
            closed += len(tickets)
        db.commit()
        if closed:
            logger.info("day close: %d unserved ticket(s) marked NO_SHOW", closed)
        return closed
    except Exception:
        db.rollback()
        logger.exception("day close failed")
        return 0
    finally:
        db.close()
