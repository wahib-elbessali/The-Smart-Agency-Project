from datetime import date, datetime

from pydantic import BaseModel

from app.schemas.insights import (
    SatisfactionInsights,
    ServiceSatisfactionInsights,
    TrendInsights,
    WaitTimeInsights,
)


class ReportPeriod(BaseModel):
    """Inclusive UTC days, the same "day" the rest of the backend uses."""

    start: date
    end: date
    days: int


class TicketsReport(BaseModel):
    """Tickets TAKEN in the period. Everything about them is read off that one
    group - including how it ended and how long it took - so the numbers add up
    and a ticket taken on the last evening is counted once, in this period,
    even if it was served the next morning."""

    created: int
    completed: int
    cancelled: int
    no_show: int
    # Still waiting or being served when the report was run - only non-zero for
    # a period that reaches today.
    unfinished: int
    # completed / created, None when no tickets were taken.
    completion_pct: float | None
    visitors_served: int


class AlertsReport(BaseModel):
    opened_total: int
    opened_by_severity: dict[str, int]
    opened_by_type: dict[str, int]
    resolved: int
    avg_resolve_minutes: float | None


class BusiestMoment(BaseModel):
    """The single busiest day and the busiest hour of the day (UTC), by tickets
    taken. None when no tickets were taken."""

    day: date | None
    day_tickets: int
    hour_utc: int | None
    hour_tickets: int


class AgencyReport(BaseModel):
    agency_id: str
    name: str
    period: ReportPeriod
    generated_at: datetime
    tickets: TicketsReport
    wait_times: WaitTimeInsights
    satisfaction: SatisfactionInsights
    service_satisfaction: ServiceSatisfactionInsights
    alerts: AlertsReport
    busiest: BusiestMoment
    # Per-day history, per-counter utilization and per-service bottleneck over
    # the period. Only on a single branch's report: a rollup has no meaningful
    # "counter" to show.
    trends: TrendInsights | None


class ReportRollup(BaseModel):
    period: ReportPeriod
    branches: list[AgencyReport]
    # Computed over every branch's raw data together, not by averaging the rows
    # above, so a quiet branch cannot pull a weighted average around.
    totals: AgencyReport
