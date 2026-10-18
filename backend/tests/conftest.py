"""In-memory SQLite stands in for Postgres so these run anywhere, with no
Docker. Modules that open their own sessions (background threads) are pointed
at the same engine."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.entities import (
    Agency,
    Alert,
    AlertSeverity,
    AlertStatus,
    Base,
    Role,
    RoleName,
    User,
)

SESSION_MODULES = [
    "app.ai_alerts.consumer",
    "app.ai_alerts.thresholds",
    "app.websocket.attendance",
    "app.services.notification_service",
    "app.services.offboarding_service",
    "app.services.door_control_service",
    "app.services.device_uptime",
    "app.services.health_monitor",
    "app.services.day_close",
    "app.ai_alerts.camera_features",
    "app.ai_alerts.base_consumer",
    "app.services.zone_watch",
]


@pytest.fixture()
def factory(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, autoflush=False, expire_on_commit=True)
    for module in SESSION_MODULES:
        monkeypatch.setattr(f"{module}.SessionLocal", maker)
    yield maker
    engine.dispose()


@pytest.fixture()
def db(factory):
    session = factory()
    yield session
    session.close()


@pytest.fixture()
def roles(db):
    rows = {name: Role(name=name) for name in RoleName}
    db.add_all(rows.values())
    db.commit()
    return rows


@pytest.fixture()
def agency(db):
    row = Agency(name="Branch A", weapon_lockdown_enabled=True)
    db.add(row)
    db.commit()
    return row


def make_user(db, roles, role, agency_id, email, active=True):
    user = User(
        email=email,
        full_name=email,
        password_hash="x",
        role_id=roles[role].id,
        agency_id=agency_id,
        is_active=active,
    )
    db.add(user)
    db.commit()
    return user


def make_alert(db, agency_id, alert_type, status=AlertStatus.OPEN, severity=AlertSeverity.CRITICAL):
    alert = Alert(
        agency_id=agency_id,
        alert_type=alert_type,
        title=alert_type,
        message=f"{alert_type} message",
        severity=severity,
        status=status,
    )
    db.add(alert)
    db.commit()
    return alert
