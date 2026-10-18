import pytest
from sqlalchemy import select

import app.services.health_monitor as hm
from app.core.config import settings
from app.models.entities import Agency, Alert, AlertStatus
from app.services.health_monitor import AI_SERVICE, HealthMonitor


@pytest.fixture()
def monitor(factory, agency, monkeypatch):
    monkeypatch.setattr(settings, "health_down_grace_seconds", 45.0)
    notified = []
    monkeypatch.setattr(hm, "notify_critical_alerts", lambda ids: notified.append(ids))
    mon = HealthMonitor()
    mon.notified = notified
    return mon


def open_alerts(db):
    db.expire_all()
    return db.scalars(
        select(Alert).where(Alert.alert_type == "ai_service_down", Alert.status == AlertStatus.OPEN)
    ).all()


def test_a_blip_inside_the_grace_period_pages_nobody(monitor, db):
    monitor.record(AI_SERVICE, False, 0.0)
    monitor.record(AI_SERVICE, False, 30.0)
    monitor.record(AI_SERVICE, True, 40.0)
    assert open_alerts(db) == [] and monitor.notified == []


def test_sustained_outage_opens_one_alert_per_active_agency_and_notifies_once(monitor, db):
    db.add(Agency(name="Inactive", is_active=False))
    db.add(Agency(name="Branch B"))
    db.commit()
    monitor.record(AI_SERVICE, False, 0.0)
    monitor.record(AI_SERVICE, False, 50.0)
    monitor.record(AI_SERVICE, False, 90.0)  # still down: no duplicates
    assert len(open_alerts(db)) == 2  # Branch A + Branch B, not the inactive one
    assert len(monitor.notified) == 1 and len(monitor.notified[0]) == 2


def test_recovery_resolves_the_alert(monitor, db):
    monitor.record(AI_SERVICE, False, 0.0)
    monitor.record(AI_SERVICE, False, 50.0)
    monitor.record(AI_SERVICE, True, 60.0)
    assert open_alerts(db) == []


def test_first_healthy_look_after_restart_clears_a_stale_alert(monitor, db, agency):
    db.add(Alert(agency_id=agency.id, alert_type="ai_service_down", title="t", message="m"))
    db.commit()
    monitor.record(AI_SERVICE, True, 0.0)
    assert open_alerts(db) == []
