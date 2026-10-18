import enum
import uuid
from datetime import date, datetime, time
from typing import Any

from sqlalchemy import Boolean, Column, DateTime, Enum, Float, ForeignKey, Integer, JSON, String, Table, Text, Time, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base


def new_uuid() -> str:
    return str(uuid.uuid4())


class RoleName(str, enum.Enum):
    ADMIN = "ADMIN"
    MANAGER = "MANAGER"
    AGENT = "AGENT"
    SECURITY = "SECURITY"
    TECHNICIAN = "TECHNICIAN"


class DeviceStatus(str, enum.Enum):
    ONLINE = "ONLINE"
    OFFLINE = "OFFLINE"
    ERROR = "ERROR"
    MAINTENANCE = "MAINTENANCE"


class EmployeeStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    ON_LEAVE = "ON_LEAVE"


class TicketStatus(str, enum.Enum):
    WAITING = "WAITING"
    CALLED = "CALLED"
    IN_SERVICE = "IN_SERVICE"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    NO_SHOW = "NO_SHOW"


class AttendanceMethod(str, enum.Enum):
    RFID = "RFID"
    FACE_RECOGNITION = "FACE_RECOGNITION"
    MANUAL = "MANUAL"


class AlertSeverity(str, enum.Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class AlertStatus(str, enum.Enum):
    OPEN = "OPEN"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    RESOLVED = "RESOLVED"


employee_zone_access = Table(
    "employee_zone_access",
    Base.metadata,
    Column("employee_id", ForeignKey("employees.id", ondelete="CASCADE"), primary_key=True),
    Column("zone_id", ForeignKey("zones.id", ondelete="CASCADE"), primary_key=True),
)


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[RoleName] = mapped_column(Enum(RoleName), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(255))

    users: Mapped[list["User"]] = relationship(back_populates="role")


class Agency(Base):
    __tablename__ = "agencies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    address: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(30))
    opening_time: Mapped[time | None] = mapped_column(Time)
    closing_time: Mapped[time | None] = mapped_column(Time)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    ticket_template: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    no_show_min_wait_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=60, server_default="60")
    # Which existing AI-service zone (by name, drawn on the Zones screen) acts
    # as this agency's kiosk zone for tracking-to-ticket linking (Phase B).
    kiosk_zone_name: Mapped[str | None] = mapped_column(String(150))
    # The camera that sees visitors' faces at the kiosk (face capture and the
    # wanted-alert link); falls back to the kiosk zone's camera when unset.
    kiosk_face_camera_id: Mapped[str | None] = mapped_column(
        ForeignKey("cameras.id", ondelete="SET NULL"), nullable=True
    )
    # Per-agency autonomous toggle: when on,
    # a confirmed weapon detection also locks every DOOR device in the agency.
    # Off = notify only, which is how the system behaved before this existed.
    # Queue signal thresholds (Phase M) - dashboard-visual only, never an Alert.
    # NULL switches that threshold off. Defaults: 5/10 tickets, 10/20 minutes.
    queue_depth_warning: Mapped[int | None] = mapped_column(Integer, nullable=True, default=5, server_default="5")
    queue_depth_critical: Mapped[int | None] = mapped_column(Integer, nullable=True, default=10, server_default="10")
    oldest_wait_warning_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True, default=600, server_default="600")
    oldest_wait_critical_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True, default=1200, server_default="1200")
    # Failed-badge signal (Phase P), dashboard-only: a door is flagged when it
    # has >= threshold failed attempts inside the window. NULL threshold = off.
    access_failure_threshold: Mapped[int | None] = mapped_column(Integer, nullable=True, default=5, server_default="5")
    access_failure_window_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=10, server_default="10")
    weapon_lockdown_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    users: Mapped[list["User"]] = relationship(back_populates="agency")
    employees: Mapped[list["Employee"]] = relationship(back_populates="agency", cascade="all, delete-orphan")
    visitors: Mapped[list["Visitor"]] = relationship(back_populates="agency", cascade="all, delete-orphan")
    devices: Mapped[list["Device"]] = relationship(back_populates="agency", cascade="all, delete-orphan")
    cameras: Mapped[list["Camera"]] = relationship(back_populates="agency", cascade="all, delete-orphan", foreign_keys="Camera.agency_id")
    alerts: Mapped[list["Alert"]] = relationship(back_populates="agency", cascade="all, delete-orphan")
    audit_logs: Mapped[list["AuditLog"]] = relationship(back_populates="agency")
    zones: Mapped[list["Zone"]] = relationship(back_populates="agency", cascade="all, delete-orphan")
    announcements: Mapped[list["Announcement"]] = relationship(back_populates="agency", cascade="all, delete-orphan")
    emotion_samples: Mapped[list["EmotionSample"]] = relationship(back_populates="agency", cascade="all, delete-orphan")
    counters: Mapped[list["Counter"]] = relationship(back_populates="agency", cascade="all, delete-orphan")
    services: Mapped[list["Service"]] = relationship(back_populates="agency", cascade="all, delete-orphan")


class Service(Base):
    __tablename__ = "services"
    __table_args__ = (UniqueConstraint("agency_id", "code", name="uq_service_agency_code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id"), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    point_type: Mapped[str] = mapped_column(String(20), nullable=False, default="COUNTER", server_default="COUNTER")
    min_points: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    agency: Mapped["Agency"] = relationship(back_populates="services")
    counters: Mapped[list["Counter"]] = relationship(back_populates="service")
    tickets: Mapped[list["Ticket"]] = relationship(back_populates="service")


class Zone(Base):
    __tablename__ = "zones"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    zone_type: Mapped[str] = mapped_column(String(50), default="PUBLIC", nullable=False)
    is_private: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # "rfid": the badge opens it. "rfid_face": the badge AND the badge
    # holder's face at door_camera_id (app/services/door_face.py).
    access_mode: Mapped[str] = mapped_column(String(20), default="rfid", server_default="rfid", nullable=False)
    door_camera_id: Mapped[str | None] = mapped_column(
        ForeignKey("cameras.id", ondelete="SET NULL"), nullable=True
    )

    agency: Mapped["Agency"] = relationship(back_populates="zones")
    door_camera: Mapped["Camera | None"] = relationship(viewonly=True)
    authorized_employees: Mapped[list["Employee"]] = relationship(
        secondary=employee_zone_access,
        back_populates="authorized_zones",
    )


class ZoneRule(Base):
    """Who may stand in a camera zone (zones themselves live in the AI
    service, keyed by name). No row = anyone. "staff": only people the
    tracker has linked to an employee; "nobody": no one at all. Watched by
    app/services/zone_watch.py."""

    __tablename__ = "zone_rules"
    __table_args__ = (UniqueConstraint("agency_id", "zone_name", name="uq_zone_rule_agency_zone"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False, index=True)
    zone_name: Mapped[str] = mapped_column(String(120), nullable=False)
    restriction: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class GalleryEntry(Base):
    """Which branch added a name to one of the AI service's site-wide
    galleries (`kind`: "watchlist" or "face"). The photos and embeddings stay
    in the AI service; this only scopes who may see and change the entry
    (app/services/branch_scope.py). agency_id null = site-wide (added by an
    administrator for every branch)."""

    __tablename__ = "gallery_entries"
    __table_args__ = (UniqueConstraint("kind", "name", name="uq_gallery_entry_kind_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    agency_id: Mapped[str | None] = mapped_column(ForeignKey("agencies.id", ondelete="SET NULL"), index=True)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class Counter(Base):
    __tablename__ = "counters"
    __table_args__ = (UniqueConstraint("agency_id", "number", name="uq_counter_agency_number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id"), nullable=False, index=True)
    service_id: Mapped[str | None] = mapped_column(ForeignKey("services.id"), index=True)
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str | None] = mapped_column(String(100))
    point_type: Mapped[str] = mapped_column(String(20), nullable=False, default="COUNTER", server_default="COUNTER")
    is_open: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Optional, manager-configured - an
    # emotion sample only counts toward THIS counter's service-satisfaction
    # reading if it lands within a ticket's in_service_at-completed_at
    # window on this specific camera.
    emotion_camera_id: Mapped[str | None] = mapped_column(ForeignKey("cameras.id"))
    # Optional, manager-set (Phase L): the AI-service workstation bound to the
    # zone this counter sits in, so the visitor board can show whether anyone
    # is physically at it right now. Plain occupancy, not employee tracking.
    workstation_name: Mapped[str | None] = mapped_column(String(150))

    agency: Mapped["Agency"] = relationship(back_populates="counters")
    service: Mapped["Service | None"] = relationship(back_populates="counters")
    tickets: Mapped[list["Ticket"]] = relationship(back_populates="counter")
    assigned_agents: Mapped[list["User"]] = relationship(back_populates="assigned_counter")


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    full_name: Mapped[str] = mapped_column(String(150), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    role_id: Mapped[str] = mapped_column(ForeignKey("roles.id"), nullable=False)
    agency_id: Mapped[str | None] = mapped_column(ForeignKey("agencies.id"))
    counter_id: Mapped[str | None] = mapped_column(
        ForeignKey("counters.id", ondelete="SET NULL"),
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    role: Mapped["Role"] = relationship(back_populates="users")
    agency: Mapped["Agency | None"] = relationship(back_populates="users")
    audit_logs: Mapped[list["AuditLog"]] = relationship(back_populates="user")
    employee: Mapped["Employee | None"] = relationship(back_populates="user", uselist=False)
    assigned_counter: Mapped["Counter | None"] = relationship(back_populates="assigned_agents")


class Employee(Base):
    __tablename__ = "employees"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id"), nullable=False, index=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), unique=True, index=True)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), unique=True, index=True)
    position: Mapped[str | None] = mapped_column(String(100))
    phone: Mapped[str | None] = mapped_column(String(30))
    rfid_uid: Mapped[str | None] = mapped_column(String(100), unique=True)
    role: Mapped[RoleName] = mapped_column(
        Enum(RoleName),
        default=RoleName.AGENT,
        server_default=RoleName.AGENT.value,
        nullable=False,
    )
    status: Mapped[EmployeeStatus] = mapped_column(
        Enum(EmployeeStatus),
        default=EmployeeStatus.ACTIVE,
        server_default=EmployeeStatus.ACTIVE.value,
        nullable=False,
    )
    hire_date: Mapped[date | None] = mapped_column()
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Live-map identity label only -
    # overwritten on every successful badge scan at a device with a
    # configured badge_zone_name, deliberately never guarded by "only if
    # unset" so it self-heals across the tracker's lack of long-term
    # re-identification. Never used for the "agent at their post" check,
    # which stays plain zone-occupancy counting (Phase B).
    tracking_id: Mapped[str | None] = mapped_column(String(50))

    agency: Mapped["Agency"] = relationship(back_populates="employees")
    attendance: Mapped[list["Attendance"]] = relationship(back_populates="employee", cascade="all, delete-orphan")
    user: Mapped["User | None"] = relationship(back_populates="employee")
    authorized_zones: Mapped[list["Zone"]] = relationship(
        secondary=employee_zone_access,
        back_populates="authorized_employees",
    )

    @property
    def authorized_zone_ids(self) -> list[str]:
        return [zone.id for zone in self.authorized_zones]


class Visitor(Base):
    __tablename__ = "visitors"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id"), nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(150), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(30))
    identity_reference: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    # Returning-visitor recognition - a
    # 512-float face embedding captured via /face/capture, no name/identity
    # attached by the AI service itself. Never exposed in VisitorResponse.
    face_embedding: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)

    agency: Mapped["Agency"] = relationship(back_populates="visitors")
    tickets: Mapped[list["Ticket"]] = relationship(back_populates="visitor", cascade="all, delete-orphan")


class Ticket(Base):
    __tablename__ = "tickets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    visitor_id: Mapped[str] = mapped_column(ForeignKey("visitors.id"), nullable=False, index=True)
    service_id: Mapped[str | None] = mapped_column(ForeignKey("services.id"), index=True)
    counter_id: Mapped[str | None] = mapped_column(ForeignKey("counters.id"), index=True)
    ticket_number: Mapped[str] = mapped_column(String(30), nullable=False)
    service_type: Mapped[str | None] = mapped_column(String(100))
    status: Mapped[TicketStatus] = mapped_column(Enum(TicketStatus), default=TicketStatus.WAITING, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    called_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    in_service_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Set by a background task shortly after kiosk ticket creation, if the
    # agency has a kiosk_zone_name configured and someone was standing in it
    # (app/services/people_tracking.py). Never set for tickets created any
    # other way (e.g. staff registering a visitor through the dashboard).
    tracking_id: Mapped[str | None] = mapped_column(String(50))
    tracking_first_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    visitor: Mapped["Visitor"] = relationship(back_populates="tickets")
    service: Mapped["Service | None"] = relationship(back_populates="tickets")
    counter: Mapped["Counter | None"] = relationship(back_populates="tickets")


class Attendance(Base):
    __tablename__ = "attendance"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    check_in: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    check_out: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    method: Mapped[AttendanceMethod] = mapped_column(Enum(AttendanceMethod), nullable=False)

    employee: Mapped["Employee"] = relationship(back_populates="attendance")


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    device_type: Mapped[str] = mapped_column(String(80), nullable=False)
    mqtt_client_id: Mapped[str] = mapped_column(String(150), unique=True, nullable=False)
    mqtt_topic: Mapped[str] = mapped_column(String(255), nullable=False)
    device_key_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[DeviceStatus] = mapped_column(Enum(DeviceStatus), default=DeviceStatus.OFFLINE, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Optional, manager-configured -
    # which AI-service zone this reader's badge scans get correlated against
    # for the live-map employee tracking link.
    badge_zone_name: Mapped[str | None] = mapped_column(String(150))
    # How often this device should be heard from at the very least (Phase O).
    # Set = a periodic publisher whose silence means something, so it is
    # tracked in the uptime history. NULL = event-driven (a badge reader, a
    # kiosk): quiet is normal, so it is deliberately not tracked.
    heartbeat_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)

    agency: Mapped["Agency"] = relationship(back_populates="devices")
    sensor_readings: Mapped[list["SensorReading"]] = relationship(back_populates="device", cascade="all, delete-orphan")
    thresholds: Mapped[list["SensorThreshold"]] = relationship(back_populates="device", cascade="all, delete-orphan")


class SensorReading(Base):
    __tablename__ = "sensor_readings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), nullable=False, index=True)
    sensor_type: Mapped[str] = mapped_column(String(80), nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    unit: Mapped[str | None] = mapped_column(String(20))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, index=True)

    device: Mapped["Device"] = relationship(back_populates="sensor_readings")


class AccessFailure(Base):
    """One failed RFID / door attempt on an authenticated device. Before this,
    a failed scan left no trace anywhere (AuditLog only covers dashboard users),
    so a flaky reader, a worn card and someone testing random cards at a door
    were indistinguishable and invisible."""

    __tablename__ = "access_failures"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id", ondelete="CASCADE"), nullable=False, index=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    scanned_uid: Mapped[str] = mapped_column(String(100), nullable=False)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id", ondelete="SET NULL"))
    zone_id: Mapped[str | None] = mapped_column(ForeignKey("zones.id", ondelete="SET NULL"))
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str] = mapped_column(String(30), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)


class DeviceStatusSample(Base):
    """One reading of whether a tracked device was online, taken every few
    minutes by the health monitor. Samples rather than transitions on purpose:
    a stretch where the backend itself was down leaves a visible gap instead of
    a falsely confident state."""

    __tablename__ = "device_status_samples"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    device_id: Mapped[str] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sampled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    online: Mapped[bool] = mapped_column(Boolean, nullable=False)


class SensorThreshold(Base):
    __tablename__ = "sensor_thresholds"
    __table_args__ = (UniqueConstraint("device_id", "sensor_type", name="uq_threshold_device_sensor"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), nullable=False, index=True)
    sensor_type: Mapped[str] = mapped_column(String(80), nullable=False)
    unit: Mapped[str | None] = mapped_column(String(20))
    warning_max: Mapped[float | None] = mapped_column(Float)
    critical_max: Mapped[float | None] = mapped_column(Float)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, server_default="true")

    device: Mapped["Device"] = relationship(back_populates="thresholds")


class Camera(Base):
    __tablename__ = "cameras"
    __table_args__ = (UniqueConstraint("name", name="uq_camera_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    stream_url: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[DeviceStatus] = mapped_column(Enum(DeviceStatus), default=DeviceStatus.OFFLINE, nullable=False)
    # Which AI detections run on this camera (app/ai_alerts/camera_features.py);
    # NULL = all of them.
    ai_features: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)

    agency: Mapped["Agency"] = relationship(back_populates="cameras", foreign_keys=[agency_id])
    alerts: Mapped[list["Alert"]] = relationship(back_populates="camera")


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id"), nullable=False, index=True)
    camera_id: Mapped[str | None] = mapped_column(ForeignKey("cameras.id"))
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"))
    # Set only for a wanted-type alert that fired on the kiosk camera close to
    # when a specific ticket was issued.
    # Unrelated alerts (the overwhelming majority) never set this.
    ticket_id: Mapped[str | None] = mapped_column(ForeignKey("tickets.id"))
    # The tracked person an intrusion alert is about (zone_watch.py).
    tracking_id: Mapped[str | None] = mapped_column(String(50))
    alert_type: Mapped[str] = mapped_column(String(80), nullable=False)
    title: Mapped[str] = mapped_column(String(150), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[AlertSeverity] = mapped_column(Enum(AlertSeverity), default=AlertSeverity.MEDIUM, nullable=False)
    status: Mapped[AlertStatus] = mapped_column(Enum(AlertStatus), default=AlertStatus.OPEN, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    agency: Mapped["Agency"] = relationship(back_populates="alerts")
    camera: Mapped["Camera | None"] = relationship(back_populates="alerts")
    # The sensor an IoT alert came from; read-only, so Device needs no back-reference.
    device: Mapped["Device | None"] = relationship(viewonly=True)


class PushSubscription(Base):
    """One browser/device a user enabled Web Push on (CRITICAL alert pipeline)."""

    __tablename__ = "push_subscriptions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    endpoint: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    p256dh: Mapped[str] = mapped_column(String(255), nullable=False)
    auth: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class AIAlertThreshold(Base):
    """Persisted business thresholds used by the backend AI consumers.

    The AI service has its own model-level confidence setting. This table stores
    the threshold used by the backend before an AI detection becomes a business
    alert. It is intentionally global because the current AI service exposes a
    single site-wide camera registry.
    """

    __tablename__ = "ai_alert_thresholds"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    alert_type: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.6, server_default="0.6")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class EmotionSample(Base):
    """One face's classified emotion, one row per detection - raw log, not
    an alert. Customer satisfaction is an AGGREGATE trend over these
    (see app/api/insights.py), not a per-visit or per-ticket score: the AI
    service's emotion stream carries class+confidence+bbox only, the same
    shape every other alert-style stream does, no track id and no ticket
    binding. That per-ticket correlation was a real, separately-tracked
    research problem (customer-satisfaction ticket-binding, now confirmed
    working per direct testing) - this table only stores what the stream
    actually sends today, honestly, without implying a per-visitor
    attribution the data doesn't carry.

    `confidence` here IS a real probability (hsemotion-onnx's own softmax
    output), unlike wanted's cosine similarity - safe to show as a percent.
    """

    __tablename__ = "emotion_samples"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str] = mapped_column(ForeignKey("agencies.id"), nullable=False, index=True)
    camera_id: Mapped[str | None] = mapped_column(ForeignKey("cameras.id"))
    emotion: Mapped[str] = mapped_column(String(30), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, index=True)

    agency: Mapped["Agency"] = relationship(back_populates="emotion_samples")
    camera: Mapped["Camera | None"] = relationship()


class Announcement(Base):
    """A message broadcast to employees (2026-09-07): pure software, no
    hardware or AI involved.

    agency_id NULL means site-wide (every agency sees it); an ADMIN is the
    only role allowed to post one of those. A MANAGER can only post scoped
    to their own agency - enforced in app/api/announcements.py, not here.
    """

    __tablename__ = "announcements"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    agency_id: Mapped[str | None] = mapped_column(ForeignKey("agencies.id"), index=True)
    author_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(150), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, index=True)

    agency: Mapped["Agency | None"] = relationship(back_populates="announcements")
    author: Mapped["User | None"] = relationship()


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    agency_id: Mapped[str | None] = mapped_column(ForeignKey("agencies.id"))
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(80))
    entity_id: Mapped[str | None] = mapped_column(String(36))
    details: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, index=True)

    user: Mapped["User | None"] = relationship(back_populates="audit_logs")
    agency: Mapped["Agency | None"] = relationship(back_populates="audit_logs")
