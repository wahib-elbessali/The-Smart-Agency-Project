from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.devices import ensure_agency_scope, get_agency_or_404
from app.core.security import get_current_user, require_roles
from app.database.connection import get_db
from app.models.entities import (
    AccessFailure,
    Agency,
    Alert,
    AlertSeverity,
    AlertStatus,
    Counter,
    Device,
    DeviceStatusSample,
    EmotionSample,
    Employee,
    RoleName,
    Service,
    Ticket,
    TicketStatus,
    User,
    Visitor,
)
from app.schemas.insights import (
    AccessFailureEvent,
    AccessFailureInsights,
    AlertsOverview,
    BranchOverview,
    CounterPerformance,
    DeviceUptime,
    DeviceUptimeDay,
    DeviceUptimeInsights,
    DoorAccessSummary,
    InsightsOverview,
    SatisfactionInsights,
    ServicePerformance,
    ServiceSatisfactionInsights,
    TicketsOverview,
    TrendDay,
    TrendInsights,
    UntrackedDevice,
    VisitorRecognitionInsights,
    WaitTimeInsights,
)
from app.services.device_uptime import is_online
from app.services.visitor_recognition import FACE_MATCH_THRESHOLD, cosine_similarity


router = APIRouter(prefix="/agencies", tags=["Insights"])
# Cross-branch routes live under /insights rather than /agencies/{id}/..., since
# they are about all branches, not one.
branches_router = APIRouter(prefix="/insights", tags=["Insights"])

# Read-only aggregation over data this backend already has - no new AI call,
# no new hardware. ADMIN/MANAGER/SECURITY, same bucket as /alerts: a
# monitoring view, not configuration.
INSIGHTS_ROLES = [Depends(require_roles(RoleName.ADMIN, RoleName.MANAGER, RoleName.SECURITY))]

# hsemotion-onnx's 8 classes (features/emotion_detection/engine.py). Anger/
# Contempt/Disgust/Fear/Sadness read as negative for a satisfaction signal;
# Happiness alone is positive; Neutral/Surprise are neither, not counted as
# a signal either way rather than guessed at.
_NEGATIVE_EMOTIONS = {"Anger", "Contempt", "Disgust", "Fear", "Sadness"}
_POSITIVE_EMOTIONS = {"Happiness"}


def _classify_percentages(counts: dict[str, int]) -> tuple[float | None, float | None, float | None]:
    """(positive_pct, neutral_pct, negative_pct) from a counts-by-emotion
    dict - shared by _satisfaction and _service_satisfaction so the
    classification rule lives in exactly one place."""
    total = sum(counts.values())

    def pct(names: set[str]) -> float | None:
        if total == 0:
            return None
        return round(100 * sum(counts.get(n, 0) for n in names) / total, 1)

    negative_pct = pct(_NEGATIVE_EMOTIONS)
    positive_pct = pct(_POSITIVE_EMOTIONS)
    neutral_pct = (
        None if total == 0 else round(max(0.0, 100 - (negative_pct or 0) - (positive_pct or 0)), 1)
    )
    return positive_pct, neutral_pct, negative_pct


def _satisfaction(db: Session, agency_id: str, hours: int) -> SatisfactionInsights:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = db.execute(
        select(EmotionSample.emotion, func.count())
        .where(EmotionSample.agency_id == agency_id, EmotionSample.recorded_at >= since)
        .group_by(EmotionSample.emotion)
    ).all()
    counts = {emotion: count for emotion, count in rows}
    positive_pct, neutral_pct, negative_pct = _classify_percentages(counts)

    return SatisfactionInsights(
        window_hours=hours,
        total_samples=sum(counts.values()),
        counts_by_emotion=counts,
        positive_pct=positive_pct,
        neutral_pct=neutral_pct,
        negative_pct=negative_pct,
    )


def _service_satisfaction(db: Session, agency_id: str, hours: int) -> ServiceSatisfactionInsights:
    """Additive sibling of _satisfaction, not a replacement - scoped to
    exactly a ticket's in_service_at-completed_at window on its counter's
    linked camera (Phase E), instead of every ambient sample in the agency.
    Most agencies will show zero coverage here until a manager links a
    camera to a counter, which is honest, not a bug."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    coverage_condition = (
        Visitor.agency_id == agency_id,
        Ticket.status == TicketStatus.COMPLETED,
        Ticket.completed_at >= since,
        Ticket.in_service_at.is_not(None),
        Counter.emotion_camera_id.is_not(None),
    )

    tickets_with_coverage = db.scalar(
        select(func.count(func.distinct(Ticket.id)))
        .select_from(Ticket)
        .join(Visitor, Visitor.id == Ticket.visitor_id)
        .join(Counter, Counter.id == Ticket.counter_id)
        .where(*coverage_condition)
    ) or 0

    rows = db.execute(
        select(EmotionSample.emotion, func.count())
        .select_from(EmotionSample)
        .join(Counter, Counter.emotion_camera_id == EmotionSample.camera_id)
        .join(Ticket, Ticket.counter_id == Counter.id)
        .join(Visitor, Visitor.id == Ticket.visitor_id)
        .where(
            *coverage_condition,
            EmotionSample.recorded_at >= Ticket.in_service_at,
            EmotionSample.recorded_at <= Ticket.completed_at,
        )
        .group_by(EmotionSample.emotion)
    ).all()
    counts = {emotion: count for emotion, count in rows}
    positive_pct, neutral_pct, negative_pct = _classify_percentages(counts)

    return ServiceSatisfactionInsights(
        window_hours=hours,
        tickets_with_coverage=tickets_with_coverage,
        total_samples=sum(counts.values()),
        counts_by_emotion=counts,
        positive_pct=positive_pct,
        neutral_pct=neutral_pct,
        negative_pct=negative_pct,
    )


def _wait_times(db: Session, agency_id: str, hours: int) -> WaitTimeInsights:
    """Four independent averages, each over only the completed tickets that
    actually have both timestamps it needs - a ticket completed without ever
    hitting "start service" has in_service_at = NULL and is correctly left
    out of walk_over/service_duration rather than counted as zero."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = db.execute(
        select(Ticket.created_at, Ticket.called_at, Ticket.in_service_at, Ticket.completed_at)
        .join(Visitor, Visitor.id == Ticket.visitor_id)
        .where(
            Visitor.agency_id == agency_id,
            Ticket.status == TicketStatus.COMPLETED,
            Ticket.completed_at >= since,
        )
    ).all()

    def avg(seconds: list[float]) -> float | None:
        return round(sum(seconds) / len(seconds), 1) if seconds else None

    queue_waits: list[float] = []
    walk_overs: list[float] = []
    service_durations: list[float] = []
    totals: list[float] = []
    for created_at, called_at, in_service_at, completed_at in rows:
        if called_at is not None:
            queue_waits.append((called_at - created_at).total_seconds())
        if called_at is not None and in_service_at is not None:
            walk_overs.append((in_service_at - called_at).total_seconds())
        if in_service_at is not None and completed_at is not None:
            service_durations.append((completed_at - in_service_at).total_seconds())
        if completed_at is not None:
            totals.append((completed_at - created_at).total_seconds())

    return WaitTimeInsights(
        window_hours=hours,
        sample_count=len(rows),
        avg_queue_wait_seconds=avg(queue_waits),
        avg_walk_over_seconds=avg(walk_overs),
        avg_service_duration_seconds=avg(service_durations),
        avg_total_seconds=avg(totals),
    )


def _visitor_recognition(db: Session, agency_id: str, days: int = 30) -> VisitorRecognitionInsights:
    """Matching is lazy, computed here rather than at capture time - see
    app/services/visitor_recognition.py's module docstring for why.

    Comparison uses EVERY visitor with an embedding, not just ones inside
    the reporting window - otherwise a real returning visitor whose first
    visit happened to fall outside `days` would be wrongly counted new.
    Only the final counts/averages are restricted to the window.
    """
    rows = db.execute(
        select(Visitor.id, Visitor.created_at, Visitor.face_embedding)
        .where(Visitor.agency_id == agency_id, Visitor.face_embedding.is_not(None))
        .order_by(Visitor.created_at)
    ).all()

    since = datetime.now(timezone.utc) - timedelta(days=days)
    seen: list[tuple[datetime, list[float]]] = []
    new_visitors = 0
    returning_visitors = 0
    gaps_days: list[float] = []

    for _visitor_id, created_at, embedding in rows:
        best_match_at: datetime | None = None
        best_score = 0.0
        for earlier_at, earlier_embedding in seen:
            score = cosine_similarity(embedding, earlier_embedding)
            if score >= FACE_MATCH_THRESHOLD and score > best_score:
                best_score = score
                best_match_at = earlier_at

        if created_at >= since:
            if best_match_at is not None:
                returning_visitors += 1
                gaps_days.append((created_at - best_match_at).total_seconds() / 86400)
            else:
                new_visitors += 1

        seen.append((created_at, embedding))

    total = new_visitors + returning_visitors
    return VisitorRecognitionInsights(
        window_days=days,
        new_visitors=new_visitors,
        returning_visitors=returning_visitors,
        returning_pct=round(100 * returning_visitors / total, 1) if total else None,
        avg_days_between_visits=round(sum(gaps_days) / len(gaps_days), 1) if gaps_days else None,
    )


# A service needs at least this many timed tickets before it can be called the
# slowest - two samples would just name whichever service had a bad hour.
_MIN_SAMPLES_FOR_SLOWEST = 5


def _opening_seconds(agency: Agency) -> int | None:
    """Daily opening length, or None when hours are missing or nonsensical
    (closing not after opening). Hours are agency-local with no timezone field
    anywhere, so only their LENGTH is used, never intersected with UTC."""
    if agency.opening_time is None or agency.closing_time is None:
        return None
    opens = agency.opening_time.hour * 3600 + agency.opening_time.minute * 60
    closes = agency.closing_time.hour * 3600 + agency.closing_time.minute * 60
    return closes - opens if closes > opens else None


def _trends(db: Session, agency: Agency, days: int) -> TrendInsights:
    """The last `days` UTC days up to and including today."""
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return _trends_range(db, agency, today - timedelta(days=days - 1), today + timedelta(days=1))


def _trends_range(
    db: Session, agency: Agency, since: datetime, until: datetime
) -> TrendInsights:
    """History for the decisions a manager actually makes: is a counter
    carrying its weight, which service is the bottleneck, are alerts and
    customer mood getting better or worse. Daily buckets are UTC days, the
    same "today" the rest of the backend uses, zero-filled. `since` and `until`
    are UTC midnights, `until` exclusive - so a past month can be reported as
    well as the days up to now."""
    now = datetime.now(timezone.utc)
    days = (until - since).days
    day_keys = [(since + timedelta(days=i)).date().isoformat() for i in range(days)]

    def day_of(moment: datetime) -> str:
        return moment.astimezone(timezone.utc).date().isoformat()

    tickets = db.execute(
        select(
            Ticket.created_at,
            Ticket.called_at,
            Ticket.in_service_at,
            Ticket.completed_at,
            Ticket.counter_id,
            Ticket.service_id,
        )
        .join(Visitor, Visitor.id == Ticket.visitor_id)
        .where(
            Visitor.agency_id == agency.id,
            Ticket.status == TicketStatus.COMPLETED,
            Ticket.completed_at >= since,
            Ticket.completed_at < until,
        )
    ).all()

    per_day_completed = {key: 0 for key in day_keys}
    per_day_service: dict[str, list[float]] = {key: [] for key in day_keys}
    by_counter: dict[str, dict] = {}
    by_service: dict[str, dict] = {}

    def bucket(store: dict, key: str) -> dict:
        return store.setdefault(key, {"completed": 0, "service": [], "waits": [], "busy": 0.0})

    for created_at, called_at, in_service_at, completed_at, counter_id, service_id in tickets:
        day = day_of(completed_at)
        per_day_completed[day] += 1
        service_seconds = (
            (completed_at - in_service_at).total_seconds() if in_service_at is not None else None
        )
        if service_seconds is not None:
            per_day_service[day].append(service_seconds)
        # A counter is occupied from the moment it calls someone, so busy time
        # starts at in_service_at when pressed and at called_at otherwise.
        started = in_service_at or called_at
        busy = max(0.0, (completed_at - started).total_seconds()) if started is not None else 0.0
        wait = (called_at - created_at).total_seconds() if called_at is not None else None
        for store, key in ((by_counter, counter_id), (by_service, service_id)):
            if key is None:
                continue
            row = bucket(store, key)
            row["completed"] += 1
            row["busy"] += busy
            if service_seconds is not None:
                row["service"].append(service_seconds)
            if wait is not None:
                row["waits"].append(wait)

    def avg(values: list[float]) -> float | None:
        return round(sum(values) / len(values), 1) if values else None

    alert_rows = db.execute(
        select(Alert.created_at, Alert.severity).where(
            Alert.agency_id == agency.id,
            Alert.created_at >= since,
            Alert.created_at < until,
        )
    ).all()
    alerts = {key: 0 for key in day_keys}
    critical = {key: 0 for key in day_keys}
    for created_at, severity in alert_rows:
        key = day_of(created_at)
        if key in alerts:
            alerts[key] += 1
            critical[key] += severity == AlertSeverity.CRITICAL

    emotion_rows = db.execute(
        select(EmotionSample.recorded_at, EmotionSample.emotion).where(
            EmotionSample.agency_id == agency.id,
            EmotionSample.recorded_at >= since,
            EmotionSample.recorded_at < until,
        )
    ).all()
    emotions: dict[str, dict[str, int]] = {key: {} for key in day_keys}
    for recorded_at, emotion in emotion_rows:
        counts = emotions.get(day_of(recorded_at))
        if counts is not None:
            counts[emotion] = counts.get(emotion, 0) + 1

    daily = []
    for key in day_keys:
        positive, _neutral, negative = _classify_percentages(emotions[key])
        daily.append(
            TrendDay(
                date=key,
                tickets_completed=per_day_completed[key],
                avg_service_seconds=avg(per_day_service[key]),
                service_samples=len(per_day_service[key]),
                alerts_opened=alerts[key],
                critical_alerts_opened=critical[key],
                satisfaction_samples=sum(emotions[key].values()),
                positive_pct=positive,
                negative_pct=negative,
            )
        )

    # Capacity is opening hours x elapsed time, with today counted only as far
    # as it has gone so a half-finished day does not deflate the percentage.
    opening = _opening_seconds(agency)
    elapsed_days = (min(now, until) - since).total_seconds() / 86400
    capacity = opening * elapsed_days if opening else None

    counters = []
    for counter in db.scalars(
        select(Counter).where(Counter.agency_id == agency.id).order_by(Counter.number)
    ):
        row = by_counter.get(counter.id, {"completed": 0, "service": [], "busy": 0.0})
        counters.append(
            CounterPerformance(
                counter_id=counter.id,
                number=counter.number,
                name=counter.name,
                tickets_completed=row["completed"],
                avg_service_seconds=avg(row["service"]),
                service_samples=len(row["service"]),
                busy_seconds=int(row["busy"]),
                utilization_pct=(
                    round(min(100.0, 100 * row["busy"] / capacity), 1) if capacity else None
                ),
            )
        )

    services = []
    for service in db.scalars(
        select(Service).where(Service.agency_id == agency.id).order_by(Service.name)
    ):
        row = by_service.get(service.id, {"completed": 0, "service": [], "waits": []})
        services.append(
            ServicePerformance(
                service_id=service.id,
                name=service.name,
                tickets_completed=row["completed"],
                avg_queue_wait_seconds=avg(row["waits"]),
                avg_service_seconds=avg(row["service"]),
                service_samples=len(row["service"]),
                is_slowest=False,
            )
        )
    comparable = [s for s in services if s.service_samples >= _MIN_SAMPLES_FOR_SLOWEST]
    if len(comparable) >= 2:
        max(comparable, key=lambda s: s.avg_service_seconds or 0).is_slowest = True

    return TrendInsights(
        days=days,
        opening_seconds_per_day=opening,
        daily=daily,
        counters=counters,
        services=services,
    )


def _device_uptime(db: Session, agency: Agency, days: int) -> DeviceUptimeInsights:
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    since = today - timedelta(days=days - 1)
    day_keys = [(since + timedelta(days=i)).date().isoformat() for i in range(days)]

    devices = db.scalars(
        select(Device).where(Device.agency_id == agency.id).order_by(Device.name)
    ).all()
    tracked = [d for d in devices if d.heartbeat_seconds is not None]

    samples_by_device: dict[str, list[tuple[datetime, bool]]] = {d.id: [] for d in tracked}
    first_sample: dict[str, datetime] = {}
    if tracked:
        ids = [d.id for d in tracked]
        for device_id, sampled_at, online in db.execute(
            select(
                DeviceStatusSample.device_id,
                DeviceStatusSample.sampled_at,
                DeviceStatusSample.online,
            )
            .where(DeviceStatusSample.device_id.in_(ids), DeviceStatusSample.sampled_at >= since)
            .order_by(DeviceStatusSample.sampled_at)
        ):
            samples_by_device[device_id].append((sampled_at, online))
        # Tracking may have started before this window; report the real start.
        first_sample = {
            device_id: moment
            for device_id, moment in db.execute(
                select(DeviceStatusSample.device_id, func.min(DeviceStatusSample.sampled_at))
                .where(DeviceStatusSample.device_id.in_(ids))
                .group_by(DeviceStatusSample.device_id)
            )
        }

    rows = []
    for device in tracked:
        samples = samples_by_device[device.id]
        online_count = sum(1 for _, online in samples if online)
        flaps = sum(1 for (_, a), (_, b) in zip(samples, samples[1:]) if a != b)
        per_day: dict[str, list[bool]] = {key: [] for key in day_keys}
        for sampled_at, online in samples:
            per_day[sampled_at.astimezone(timezone.utc).date().isoformat()].append(online)
        rows.append(
            DeviceUptime(
                device_id=device.id,
                name=device.name,
                device_type=device.device_type,
                heartbeat_seconds=device.heartbeat_seconds,
                currently_online=is_online(device, now),
                last_seen_at=device.last_seen_at,
                samples=len(samples),
                online_pct=round(100 * online_count / len(samples), 1) if samples else None,
                flaps=flaps,
                tracking_since=first_sample.get(device.id),
                daily=[
                    DeviceUptimeDay(
                        date=key,
                        online_pct=(
                            round(100 * sum(per_day[key]) / len(per_day[key]), 1)
                            if per_day[key]
                            else None
                        ),
                    )
                    for key in day_keys
                ],
            )
        )

    return DeviceUptimeInsights(
        days=days,
        devices=rows,
        untracked=[
            UntrackedDevice(device_id=d.id, name=d.name, device_type=d.device_type)
            for d in devices
            if d.heartbeat_seconds is None
        ],
    )


def _access_failures(db: Session, agency: Agency) -> AccessFailureInsights:
    now = datetime.now(timezone.utc)
    window = timedelta(minutes=agency.access_failure_window_minutes)
    day_ago = now - timedelta(hours=24)

    rows = db.execute(
        select(AccessFailure, Employee.first_name, Employee.last_name)
        .outerjoin(Employee, Employee.id == AccessFailure.employee_id)
        .where(AccessFailure.agency_id == agency.id, AccessFailure.occurred_at >= day_ago)
        .order_by(AccessFailure.occurred_at.desc())
    ).all()
    by_device: dict[str, list] = {}
    for failure, first, last in rows:
        by_device.setdefault(failure.device_id, []).append((failure, first, last))

    names = {
        d.id: d.name
        for d in db.scalars(select(Device).where(Device.id.in_(list(by_device)))).all()
    } if by_device else {}

    doors = []
    for device_id, entries in by_device.items():
        in_window = [f for f, _, _ in entries if f.occurred_at >= now - window]
        reasons: dict[str, int] = {}
        for failure in in_window:
            reasons[failure.reason] = reasons.get(failure.reason, 0) + 1
        threshold = agency.access_failure_threshold
        doors.append(
            DoorAccessSummary(
                device_id=device_id,
                name=names.get(device_id, device_id),
                failures_in_window=len(in_window),
                failures_24h=len(entries),
                distinct_cards_in_window=len({f.scanned_uid for f in in_window}),
                by_reason=reasons,
                last_failure_at=entries[0][0].occurred_at,
                flagged=threshold is not None and len(in_window) >= threshold,
                recent=[
                    AccessFailureEvent(
                        occurred_at=f.occurred_at,
                        scanned_uid=f.scanned_uid,
                        reason=f.reason,
                        source=f.source,
                        employee_name=f"{first} {last}" if first is not None else None,
                    )
                    for f, first, last in entries[:5]
                ],
            )
        )
    # Flagged doors first, then the busiest.
    doors.sort(key=lambda d: (not d.flagged, -d.failures_in_window, -d.failures_24h))
    return AccessFailureInsights(
        window_minutes=agency.access_failure_window_minutes,
        threshold=agency.access_failure_threshold,
        doors=doors,
    )


@router.get(
    "/{agency_id}/insights/access",
    response_model=AccessFailureInsights,
    dependencies=INSIGHTS_ROLES,
)
def get_access_failures(
    agency_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AccessFailureInsights:
    """Failed badge attempts per door over the last 24 hours, with the
    per-agency threshold evaluated live. A dashboard signal only - the cause
    (a flaky reader, a worn card, someone probing) is ambiguous by design, so
    this shows the evidence rather than a verdict."""
    agency = get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    return _access_failures(db, agency)


@router.get(
    "/{agency_id}/insights/devices",
    response_model=DeviceUptimeInsights,
    dependencies=INSIGHTS_ROLES,
)
def get_device_uptime(
    agency_id: str,
    days: int = Query(default=7, ge=1, le=90),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceUptimeInsights:
    """Uptime and flapping for devices a manager marked as periodic publishers
    (heartbeat_seconds). Event-driven devices are listed as untracked."""
    agency = get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    return _device_uptime(db, agency, days)


@router.get(
    "/{agency_id}/insights/trends",
    response_model=TrendInsights,
    dependencies=INSIGHTS_ROLES,
)
def get_trends(
    agency_id: str,
    days: int = Query(default=7, ge=1, le=90),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrendInsights:
    """History for decisions, not a number dump: daily tickets, service time,
    alerts and mood; per-counter utilization; per-service bottleneck. See the
    schemas for what "utilization" does and does not mean."""
    agency = get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    return _trends(db, agency, days)


@router.get(
    "/{agency_id}/insights/satisfaction",
    response_model=SatisfactionInsights,
    dependencies=INSIGHTS_ROLES,
)
def get_satisfaction(
    agency_id: str,
    hours: int = Query(default=24, ge=1, le=24 * 30),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SatisfactionInsights:
    """Aggregate emotion trend, NOT a per-visitor or per-ticket score - the
    AI stream carries class+confidence+bbox only, no track id. See
    EmotionSample's own doc comment for why that's an honest limit, not an
    oversight."""
    get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    return _satisfaction(db, agency_id, hours)


@router.get(
    "/{agency_id}/insights/overview",
    response_model=InsightsOverview,
    dependencies=INSIGHTS_ROLES,
)
def get_overview(
    agency_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> InsightsOverview:
    get_agency_or_404(agency_id, db)
    ensure_agency_scope(agency_id, current_user)
    return _overview(db, agency_id)


def _overview(db: Session, agency_id: str) -> InsightsOverview:
    """One branch's live overview. Shared by the per-branch endpoint and the
    admin's branch comparison, so the two can never disagree about a number."""
    severity_rows = db.execute(
        select(Alert.severity, func.count())
        .where(Alert.agency_id == agency_id, Alert.status.in_((AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED)))
        .group_by(Alert.severity)
    ).all()
    open_by_severity = {severity.value: count for severity, count in severity_rows}
    for severity in AlertSeverity:
        open_by_severity.setdefault(severity.value, 0)

    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    def ticket_count(*statuses: TicketStatus, since: datetime | None = None) -> int:
        query = (
            select(func.count())
            .select_from(Ticket)
            .join(Visitor, Visitor.id == Ticket.visitor_id)
            .where(Visitor.agency_id == agency_id, Ticket.status.in_(statuses))
        )
        if since is not None:
            query = query.where(Ticket.created_at >= since)
        return db.scalar(query) or 0

    tickets = TicketsOverview(
        waiting=ticket_count(TicketStatus.WAITING),
        in_service=ticket_count(TicketStatus.CALLED, TicketStatus.IN_SERVICE),
        completed_today=ticket_count(TicketStatus.COMPLETED, since=today_start),
        cancelled_today=ticket_count(TicketStatus.CANCELLED, since=today_start),
    )

    return InsightsOverview(
        alerts=AlertsOverview(
            open_by_severity=open_by_severity,
            open_total=sum(open_by_severity.values()),
        ),
        tickets=tickets,
        satisfaction=_satisfaction(db, agency_id, hours=24),
        wait_times=_wait_times(db, agency_id, hours=24),
        visitor_recognition=_visitor_recognition(db, agency_id),
        service_satisfaction=_service_satisfaction(db, agency_id, hours=24),
    )


@branches_router.get("/branches", response_model=list[BranchOverview])
def compare_branches(
    current_user: User = Depends(require_roles(RoleName.ADMIN)),
    db: Session = Depends(get_db),
) -> list[BranchOverview]:
    """Every branch's live overview side by side, for the admin's comparison
    table. ADMIN only - a manager or security user is scoped to one branch
    everywhere else, and this would be the one route that is not. Exactly the
    metrics the per-branch overview already has: nothing is invented for the
    comparison, and nothing is ranked or flagged, so the admin decides what
    looks off."""
    agencies = db.scalars(select(Agency).order_by(Agency.name)).all()
    return [
        BranchOverview(
            agency_id=agency.id,
            name=agency.name,
            is_active=agency.is_active,
            overview=_overview(db, agency.id),
        )
        for agency in agencies
    ]
