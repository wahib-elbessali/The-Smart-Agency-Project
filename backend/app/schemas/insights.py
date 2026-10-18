from datetime import datetime

from pydantic import BaseModel


class SatisfactionInsights(BaseModel):
    window_hours: int
    total_samples: int
    counts_by_emotion: dict[str, int]
    # Anger/Contempt/Disgust/Fear/Sadness = negative, Happiness = positive,
    # Neutral/Surprise = neutral - see app/api/insights.py's own mapping.
    positive_pct: float | None
    neutral_pct: float | None
    negative_pct: float | None


class AlertsOverview(BaseModel):
    open_by_severity: dict[str, int]
    open_total: int


class TicketsOverview(BaseModel):
    waiting: int
    in_service: int
    completed_today: int
    cancelled_today: int


class WaitTimeInsights(BaseModel):
    window_hours: int
    sample_count: int
    avg_queue_wait_seconds: float | None
    avg_walk_over_seconds: float | None
    avg_service_duration_seconds: float | None
    avg_total_seconds: float | None


class VisitorRecognitionInsights(BaseModel):
    """Returning-visitor recognition by face alone (Phase D) - window_days,
    not window_hours, since visit-return patterns operate on a days/weeks
    timescale unlike every other insight here. avg_days_between_visits is
    an average, not a full distribution - same simplification every other
    insight in this project already makes (percentages/averages, not raw
    histograms)."""

    window_days: int
    new_visitors: int
    returning_visitors: int
    returning_pct: float | None
    avg_days_between_visits: float | None


class ServiceSatisfactionInsights(BaseModel):
    """Same shape as SatisfactionInsights, but scoped to exactly a ticket's
    in_service_at-completed_at window on its counter's linked camera (Phase
    E) - "this visitor's actual service interaction," not ambient lobby
    mood. Additive, not a replacement: the existing ambient `satisfaction`
    field is untouched. `tickets_with_coverage` is distinct from
    `total_samples` - a covered ticket (linked camera, valid timestamps)
    can still have zero actual samples if no face was visible in that
    window."""

    window_hours: int
    tickets_with_coverage: int
    total_samples: int
    counts_by_emotion: dict[str, int]
    positive_pct: float | None
    neutral_pct: float | None
    negative_pct: float | None


class InsightsOverview(BaseModel):
    alerts: AlertsOverview
    tickets: TicketsOverview
    satisfaction: SatisfactionInsights
    wait_times: WaitTimeInsights
    visitor_recognition: VisitorRecognitionInsights
    service_satisfaction: ServiceSatisfactionInsights


class TrendDay(BaseModel):
    """One UTC day. Zero-filled, so a quiet day is a visible zero, not a gap."""

    date: str
    tickets_completed: int
    avg_service_seconds: float | None
    service_samples: int
    alerts_opened: int
    critical_alerts_opened: int
    satisfaction_samples: int
    positive_pct: float | None
    negative_pct: float | None


class CounterPerformance(BaseModel):
    counter_id: str
    number: int
    name: str | None
    tickets_completed: int
    avg_service_seconds: float | None
    service_samples: int
    busy_seconds: int
    # Share of the agency's opening hours the counter spent serving. Idle time
    # includes closed and unstaffed time - there is no staffing history to
    # tell those apart. None when the agency has no usable opening hours.
    utilization_pct: float | None


class ServicePerformance(BaseModel):
    service_id: str
    name: str
    tickets_completed: int
    avg_queue_wait_seconds: float | None
    avg_service_seconds: float | None
    service_samples: int
    # The slowest service among those with enough samples to compare.
    is_slowest: bool


class TrendInsights(BaseModel):
    days: int
    opening_seconds_per_day: int | None
    daily: list[TrendDay]
    counters: list[CounterPerformance]
    services: list[ServicePerformance]


class DeviceUptimeDay(BaseModel):
    date: str
    # None = no samples that day (the backend was off, or tracking had not
    # started), which is different from 0% online.
    online_pct: float | None


class DeviceUptime(BaseModel):
    device_id: str
    name: str
    device_type: str
    heartbeat_seconds: int
    currently_online: bool
    last_seen_at: datetime | None
    samples: int
    online_pct: float | None
    # State changes between consecutive samples. A device that flickers is the
    # "flaky hardware" this metric exists to catch, and a plain percentage
    # hides it: 90% online reads the same for one long outage or twenty blips.
    flaps: int
    tracking_since: datetime | None
    daily: list[DeviceUptimeDay]


class UntrackedDevice(BaseModel):
    device_id: str
    name: str
    device_type: str


class DeviceUptimeInsights(BaseModel):
    days: int
    devices: list[DeviceUptime]
    # Event-driven devices (no heartbeat configured): quiet is normal for
    # them, so they are listed, not guessed at.
    untracked: list[UntrackedDevice]


class AccessFailureEvent(BaseModel):
    occurred_at: datetime
    scanned_uid: str
    reason: str
    source: str
    # Set when the card belongs to a known employee (an inactive one, or one
    # refused at a zone) - that is what separates "this person's card" from
    # "a card nobody recognises".
    employee_name: str | None


class DoorAccessSummary(BaseModel):
    device_id: str
    name: str
    failures_in_window: int
    failures_24h: int
    # One card failing repeatedly and many different cards failing once each
    # look very different, so the evidence is shown instead of a verdict.
    distinct_cards_in_window: int
    by_reason: dict[str, int]
    last_failure_at: datetime | None
    flagged: bool
    recent: list[AccessFailureEvent]


class AccessFailureInsights(BaseModel):
    window_minutes: int
    # None = the signal is switched off for this agency.
    threshold: int | None
    doors: list[DoorAccessSummary]


class BranchOverview(BaseModel):
    """One row of the admin's branch comparison: a branch and its live overview."""

    agency_id: str
    name: str
    is_active: bool
    overview: InsightsOverview
