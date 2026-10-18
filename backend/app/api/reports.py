"""End-of-month reporting.

The historical counterpart of the live Insights screen and the live branch
comparison: the same kinds of measures, over a date range someone picks, for one
branch (a manager reviewing their own month) or for every branch at once (an
admin's rollup). A dashboard view, not an exportable file, and nothing here
changes while someone is looking at it - a fixed past period does not move - so
the screen does not poll.

Additive: the live Insights functions are untouched. These are range-based
siblings that read the same tables.
"""

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.devices import ensure_agency_scope, get_agency_or_404
from app.api.insights import _classify_percentages, _trends_range
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import (
    Agency,
    Alert,
    AlertStatus,
    Counter,
    EmotionSample,
    RoleName,
    Ticket,
    TicketStatus,
    User,
    Visitor,
)
from app.schemas.insights import (
    SatisfactionInsights,
    ServiceSatisfactionInsights,
    WaitTimeInsights,
)
from app.schemas.reports import (
    AgencyReport,
    AlertsReport,
    BusiestMoment,
    ReportPeriod,
    ReportRollup,
    TicketsReport,
)


router = APIRouter(tags=["Reports"])

# A review is a month, a quarter or a year at most - and the trends query reads
# every ticket in the range into memory.
MAX_REPORT_DAYS = 366


def _window(start: date, end: date) -> tuple[ReportPeriod, datetime, datetime]:
    today = datetime.now(timezone.utc).date()
    if end < start:
        raise HTTPException(status_code=422, detail="La date de fin precede la date de debut")
    if end > today:
        raise HTTPException(
            status_code=422, detail="Un rapport ne couvre pas l avenir: la date de fin depasse aujourd hui"
        )
    days = (end - start).days + 1
    if days > MAX_REPORT_DAYS:
        raise HTTPException(status_code=422, detail=f"Periode trop longue (maximum {MAX_REPORT_DAYS} jours)")
    since = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    return ReportPeriod(start=start, end=end, days=days), since, since + timedelta(days=days)


def _avg(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 1) if values else None


def _report_core(
    db: Session,
    agency_ids: list[str],
    name: str,
    report_id: str,
    period: ReportPeriod,
    since: datetime,
    until: datetime,
) -> AgencyReport:
    hours = period.days * 24

    # --- tickets taken in the period --------------------------------------
    rows = db.execute(
        select(
            Ticket.visitor_id,
            Ticket.status,
            Ticket.created_at,
            Ticket.called_at,
            Ticket.in_service_at,
            Ticket.completed_at,
        )
        .join(Visitor, Visitor.id == Ticket.visitor_id)
        .where(
            Visitor.agency_id.in_(agency_ids),
            Ticket.created_at >= since,
            Ticket.created_at < until,
        )
    ).all()

    by_status = {status: 0 for status in TicketStatus}
    queue_waits: list[float] = []
    walk_overs: list[float] = []
    services: list[float] = []
    totals: list[float] = []
    per_day: dict[date, int] = {}
    per_hour: dict[int, int] = {}
    for _visitor, status, created_at, called_at, in_service_at, completed_at in rows:
        by_status[status] += 1
        created_utc = created_at.astimezone(timezone.utc)
        per_day[created_utc.date()] = per_day.get(created_utc.date(), 0) + 1
        per_hour[created_utc.hour] = per_hour.get(created_utc.hour, 0) + 1
        if called_at is not None:
            queue_waits.append((called_at - created_at).total_seconds())
        if called_at is not None and in_service_at is not None:
            walk_overs.append((in_service_at - called_at).total_seconds())
        if in_service_at is not None and completed_at is not None:
            services.append((completed_at - in_service_at).total_seconds())
        if completed_at is not None:
            totals.append((completed_at - created_at).total_seconds())

    created = len(rows)
    completed = by_status[TicketStatus.COMPLETED]
    tickets = TicketsReport(
        created=created,
        completed=completed,
        cancelled=by_status[TicketStatus.CANCELLED],
        no_show=by_status[TicketStatus.NO_SHOW],
        unfinished=by_status[TicketStatus.WAITING]
        + by_status[TicketStatus.CALLED]
        + by_status[TicketStatus.IN_SERVICE],
        completion_pct=round(100 * completed / created, 1) if created else None,
        visitors_served=len({row[0] for row in rows}),
    )
    wait_times = WaitTimeInsights(
        window_hours=hours,
        sample_count=completed,
        avg_queue_wait_seconds=_avg(queue_waits),
        avg_walk_over_seconds=_avg(walk_overs),
        avg_service_duration_seconds=_avg(services),
        avg_total_seconds=_avg(totals),
    )

    busiest_day = max(per_day.items(), key=lambda item: (item[1], item[0]), default=None)
    busiest_hour = max(per_hour.items(), key=lambda item: (item[1], -item[0]), default=None)
    busiest = BusiestMoment(
        day=busiest_day[0] if busiest_day else None,
        day_tickets=busiest_day[1] if busiest_day else 0,
        hour_utc=busiest_hour[0] if busiest_hour else None,
        hour_tickets=busiest_hour[1] if busiest_hour else 0,
    )

    # --- customer mood ------------------------------------------------------
    emotion_rows = db.execute(
        select(EmotionSample.emotion, func.count())
        .where(
            EmotionSample.agency_id.in_(agency_ids),
            EmotionSample.recorded_at >= since,
            EmotionSample.recorded_at < until,
        )
        .group_by(EmotionSample.emotion)
    ).all()
    counts = {emotion: count for emotion, count in emotion_rows}
    positive, neutral, negative = _classify_percentages(counts)
    satisfaction = SatisfactionInsights(
        window_hours=hours,
        total_samples=sum(counts.values()),
        counts_by_emotion=counts,
        positive_pct=positive,
        neutral_pct=neutral,
        negative_pct=negative,
    )

    # Mood during actual service: only tickets whose counter has a camera linked,
    # and only samples inside that ticket's own service window (Phase E).
    coverage = (
        Visitor.agency_id.in_(agency_ids),
        Ticket.status == TicketStatus.COMPLETED,
        Ticket.completed_at >= since,
        Ticket.completed_at < until,
        Ticket.in_service_at.is_not(None),
        Counter.emotion_camera_id.is_not(None),
    )
    covered = db.scalar(
        select(func.count(func.distinct(Ticket.id)))
        .select_from(Ticket)
        .join(Visitor, Visitor.id == Ticket.visitor_id)
        .join(Counter, Counter.id == Ticket.counter_id)
        .where(*coverage)
    ) or 0
    service_rows = db.execute(
        select(EmotionSample.emotion, func.count())
        .select_from(EmotionSample)
        .join(Counter, Counter.emotion_camera_id == EmotionSample.camera_id)
        .join(Ticket, Ticket.counter_id == Counter.id)
        .join(Visitor, Visitor.id == Ticket.visitor_id)
        .where(
            *coverage,
            EmotionSample.recorded_at >= Ticket.in_service_at,
            EmotionSample.recorded_at <= Ticket.completed_at,
        )
        .group_by(EmotionSample.emotion)
    ).all()
    service_counts = {emotion: count for emotion, count in service_rows}
    s_positive, s_neutral, s_negative = _classify_percentages(service_counts)
    service_satisfaction = ServiceSatisfactionInsights(
        window_hours=hours,
        tickets_with_coverage=covered,
        total_samples=sum(service_counts.values()),
        counts_by_emotion=service_counts,
        positive_pct=s_positive,
        neutral_pct=s_neutral,
        negative_pct=s_negative,
    )

    # --- alerts opened in the period ---------------------------------------
    alert_rows = db.execute(
        select(Alert.severity, Alert.alert_type, Alert.status, Alert.created_at, Alert.resolved_at).where(
            Alert.agency_id.in_(agency_ids),
            Alert.created_at >= since,
            Alert.created_at < until,
        )
    ).all()
    by_severity: dict[str, int] = {}
    by_type: dict[str, int] = {}
    resolve_minutes: list[float] = []
    for severity, alert_type, status, opened_at, resolved_at in alert_rows:
        by_severity[severity.value] = by_severity.get(severity.value, 0) + 1
        by_type[alert_type] = by_type.get(alert_type, 0) + 1
        if status == AlertStatus.RESOLVED and resolved_at is not None:
            resolve_minutes.append(max(0.0, (resolved_at - opened_at).total_seconds() / 60))
    alerts = AlertsReport(
        opened_total=len(alert_rows),
        opened_by_severity=by_severity,
        opened_by_type=dict(sorted(by_type.items(), key=lambda item: (-item[1], item[0]))),
        resolved=len(resolve_minutes),
        avg_resolve_minutes=_avg(resolve_minutes),
    )

    return AgencyReport(
        agency_id=report_id,
        name=name,
        period=period,
        generated_at=datetime.now(timezone.utc),
        tickets=tickets,
        wait_times=wait_times,
        satisfaction=satisfaction,
        service_satisfaction=service_satisfaction,
        alerts=alerts,
        busiest=busiest,
        trends=None,
    )


REPORT_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER))]


@router.get("/agencies/{agency_id}/report", response_model=AgencyReport, dependencies=REPORT_ROLES)
def get_agency_report(
    agency_id: str,
    start: date = Query(),
    end: date = Query(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AgencyReport:
    """One branch over a date range: a manager reviewing their own month, or an
    admin looking at one branch of the rollup."""
    agency = get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    period, since, until = _window(start, end)
    report = _report_core(db, [agency.id], agency.name, agency.id, period, since, until)
    report.trends = _trends_range(db, agency, since, until)
    return report


@router.get(
    "/reports/branches",
    response_model=ReportRollup,
    dependencies=[Depends(require_roles(RoleName.ADMIN))],
)
def get_branch_rollup(
    start: date = Query(),
    end: date = Query(),
    db: Session = Depends(get_db),
) -> ReportRollup:
    """Every branch over the same range, plus totals computed from all of their
    raw data together. ADMIN only."""
    period, since, until = _window(start, end)
    agencies = db.scalars(select(Agency).order_by(Agency.name)).all()
    branches = [
        _report_core(db, [a.id], a.name, a.id, period, since, until) for a in agencies
    ]
    totals = _report_core(
        db, [a.id for a in agencies], "All branches", "all", period, since, until
    )
    return ReportRollup(period=period, branches=branches, totals=totals)
