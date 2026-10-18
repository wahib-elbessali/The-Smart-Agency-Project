"""Is a branch set up?

A new branch needs a lot configured, in an order the code actually requires,
and nothing showed what was still missing. This answers that as a live,
derived checklist - every item is computed from data that already exists, so
there is no stored "setup progress" flag to maintain or let drift from reality.
It blocks nothing: a branch can go live half-configured if that is genuinely
fine, and the steps can be done in any order.

Three steps depend on the AI service (a camera calibrated and aligned, an
occupancy zone drawn, a face enrolled). If that service cannot be reached the
step is reported as "unknown", never "todo": being unable to look is not the
same as it being missing, and telling a manager their calibration is undone
because the AI service restarted would be a false instruction.
"""

import logging
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.ai_alerts.ai_service import forward, raise_for_ai_status
from app.models.entities import (
    Agency,
    Camera,
    Counter,
    Device,
    Employee,
    Role,
    RoleName,
    SensorThreshold,
    Service,
    User,
)
from app.services.door_face import face_key
from app.services.offboarding_service import name_keys, normalise_name


logger = logging.getLogger(__name__)

Status = Literal["done", "todo", "unknown"]


@dataclass
class Item:
    key: str
    group: str
    label: str
    why: str
    status: Status
    detail: str
    link: str | None


def _ai_json(path: str, expected: type) -> Any | None:
    """The AI service's answer, or None on anything that is not a clean one,
    including a reply of the wrong shape: that must read as "could not check",
    not crash the page. Short timeout - three of these run one after another
    and a hung AI service must not make the checklist take half a minute."""
    try:
        response = forward("GET", path, timeout=3.0)
        raise_for_ai_status(response)
        body = response.json()
        if not isinstance(body, expected):
            raise ValueError(f"unexpected {type(body).__name__}")
        return body
    except Exception:
        logger.warning("setup status: AI service unavailable for %s", path)
        return None


def _count(db: Session, query) -> int:
    return db.scalar(query) or 0


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def compute_setup_status(db: Session, agency: Agency) -> list[Item]:
    agency_id = agency.id
    items: list[Item] = []

    def add(key, group, label, why, done: bool, detail: str, link: str | None) -> None:
        items.append(Item(key, group, label, why, "done" if done else "todo", detail, link))

    def add_ai(key, group, label, why, outcome: bool | None, detail: str, link: str | None) -> None:
        status: Status = "unknown" if outcome is None else ("done" if outcome else "todo")
        items.append(
            Item(
                key,
                group,
                label,
                why,
                status,
                "Could not check right now - the AI service did not answer." if outcome is None else detail,
                link,
            )
        )

    # --- Foundation ---------------------------------------------------------
    has_hours = (
        agency.opening_time is not None
        and agency.closing_time is not None
        and agency.closing_time > agency.opening_time
    )
    add(
        "hours", "Foundation", "Opening hours set",
        "Used to work out how busy each counter is.",
        has_hours, "Set" if has_hours else "No opening and closing time yet", "/agencies",
    )
    devices = _count(db, select(func.count()).select_from(Device).where(Device.agency_id == agency_id))
    add(
        "devices", "Foundation", "IoT devices registered",
        "Sensors, door readers and the ticket kiosk each need a registered device and key.",
        devices > 0, _plural(devices, "device"), "/devices",
    )
    cameras = db.scalars(select(Camera).where(Camera.agency_id == agency_id)).all()
    add(
        "cameras", "Foundation", "Cameras added",
        "Every AI feature - weapons, fire, faces, occupancy - starts from a camera.",
        len(cameras) > 0, _plural(len(cameras), "camera"), "/cameras",
    )

    # --- Vision (needs the AI service) -------------------------------------
    camera_names = {camera.name for camera in cameras}
    calibration = _ai_json("/calibration", dict)
    aligned: bool | None = None
    if calibration is not None:
        aligned = any(
            name in camera_names and (entry.get("diagnostics") or {}).get("aligned")
            for name, entry in calibration.items()
        )
    add_ai(
        "calibration", "Vision", "A camera calibrated and aligned",
        "Needed before people can be placed on the floor plan.",
        aligned, "At least one camera is aligned" if aligned else "No camera of this branch is aligned yet",
        "/calibration",
    )
    zones = _ai_json("/zoning/zones", dict)
    drawn: bool | None = None
    if zones is not None:
        drawn = any(
            (zone.get("camera") or (zone.get("converted_from") or {}).get("camera")) in camera_names
            for zone in zones.values()
        )
    add_ai(
        "zones", "Vision", "An occupancy zone drawn",
        "Counts how many people are in an area, and feeds the kiosk and counter checks.",
        drawn, "At least one zone is drawn" if drawn else "No zone drawn on this branch's cameras yet",
        "/zones",
    )
    add(
        "kiosk_zone", "Vision", "Kiosk zone chosen",
        "Links each ticket to the person the cameras see at the kiosk (live map, returning visitors).",
        bool(agency.kiosk_zone_name),
        f"Kiosk zone: {agency.kiosk_zone_name}" if agency.kiosk_zone_name else "No kiosk zone chosen yet",
        "/agencies",
    )
    badge_zones = db.scalars(
        select(Device.name).where(Device.agency_id == agency_id, Device.badge_zone_name.is_not(None))
    ).all()
    add(
        "badge_zone", "Vision", "A badge reader has a badge zone",
        "Links a badge tap to the person the cameras see: names on the live map, and who counts as "
        "staff in a Staff only zone (without it, everyone there is an intruder).",
        len(badge_zones) > 0,
        ", ".join(badge_zones) if badge_zones else "No reader has a badge zone yet",
        "/devices",
    )

    # --- People -------------------------------------------------------------
    employees = db.scalars(select(Employee).where(Employee.agency_id == agency_id)).all()
    add(
        "employees", "People", "Employees added",
        "Attendance and door access are per employee.",
        len(employees) > 0, _plural(len(employees), "employee"), "/employees",
    )
    badged = sum(1 for employee in employees if employee.rfid_uid)
    add(
        "badges", "People", "An employee has an RFID badge",
        "Without one nobody can clock in or open a door.",
        badged > 0, f"{badged} of {len(employees)} have a badge", "/employees",
    )
    agents = _count(
        db,
        select(func.count())
        .select_from(User)
        .join(Role, User.role_id == Role.id)
        .where(User.agency_id == agency_id, Role.name == RoleName.AGENT, User.is_active.is_(True)),
    )
    add(
        "logins", "People", "An agent login exists",
        "Agents serve the queue from their own account.",
        agents > 0, _plural(agents, "active agent account"), "/users",
    )
    gallery = _ai_json("/face/faces", list)
    enrolled: bool | None = None
    if gallery is not None:
        names = {entry.get("name", "") for entry in gallery}
        known = {normalise_name(name) for name in names}
        # by name (face recognition), or under the employee's own key (badge + face doors)
        enrolled = any(
            name_keys(e.first_name, e.last_name) & known or face_key(e.id) in names for e in employees
        )
    add_ai(
        "faces", "People", "An employee has a face enrolled",
        "Lets the face-recognition checks recognise staff.",
        enrolled, "At least one employee is enrolled" if enrolled else "No employee of this branch is enrolled yet",
        "/faces",
    )

    # --- Queue --------------------------------------------------------------
    services = _count(
        db,
        select(func.count())
        .select_from(Service)
        .where(Service.agency_id == agency_id, Service.is_active.is_(True)),
    )
    add(
        "services", "Queue", "A service is defined",
        "A ticket is always for a service.",
        services > 0, _plural(services, "active service"), "/services",
    )
    counters = db.scalars(select(Counter).where(Counter.agency_id == agency_id)).all()
    serving = [counter for counter in counters if counter.service_id is not None]
    add(
        "counters", "Queue", "A counter serves a service",
        "A counter with no service cannot be given to an agent.",
        len(serving) > 0, f"{len(serving)} of {len(counters)} counters have a service", None,
    )
    staffed = _count(
        db,
        select(func.count())
        .select_from(User)
        .join(Counter, User.counter_id == Counter.id)
        .where(Counter.agency_id == agency_id, User.is_active.is_(True)),
    )
    add(
        "assigned", "Queue", "An agent is assigned to a counter",
        "Nobody is called to a counter that has nobody on it.",
        staffed > 0, _plural(staffed, "agent") + " assigned", "/visitors",
    )
    custom_layout = bool(agency.ticket_template)
    add(
        "ticket_layout", "Queue", "Ticket layout customised",
        "Until then every ticket prints the generic default.",
        custom_layout, "Custom layout saved" if custom_layout else "Still the generic default", "/ticket-template",
    )

    # --- Safety -------------------------------------------------------------
    thresholds = _count(
        db,
        select(func.count())
        .select_from(SensorThreshold)
        .join(Device, SensorThreshold.device_id == Device.id)
        .where(Device.agency_id == agency_id, SensorThreshold.is_active.is_(True)),
    )
    add(
        "thresholds", "Safety", "Sensor thresholds set",
        "Without them a gas, heat or humidity reading never raises an alert.",
        thresholds > 0, _plural(thresholds, "active threshold"), "/devices",
    )
    return items
