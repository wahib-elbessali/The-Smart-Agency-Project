"""Create a repeatable development dataset for SmartAgency.

Run this script after applying the Alembic migrations:

    python seed_dev.py

The script only touches records identified by the ``smartagency.local``
development emails, the ``DEV-*`` service codes, and the
``access-sensors-1`` development device. It is safe to run more than once.

Environment variables:

``SEED_PASSWORD``
    Password assigned when a seeded account is created. Default:
    ``Admin12345``.
``SEED_RESET_PASSWORD``
    Set to ``true`` to reset seeded account passwords on every run. Default:
    ``false``.
``SEED_DEVICE_KEY``
    Device key stored for the development ``access-sensors-1`` device.
    Default: ``access-sensors-1-dev-key``.
"""

from __future__ import annotations

import os
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select

from app.core.device_security import hash_device_key
from app.core.security import hash_password
from app.database.connection import SessionLocal
from app.models.entities import (
    Agency,
    Alert,
    AlertSeverity,
    AlertStatus,
    Attendance,
    AttendanceMethod,
    Camera,
    Counter,
    Device,
    DeviceStatus,
    Employee,
    EmployeeStatus,
    AIAlertThreshold,
    Role,
    RoleName,
    SensorThreshold,
    Service,
    Ticket,
    TicketStatus,
    User,
    Visitor,
    Zone,
)


AGENCY_NAME = "Agence Casablanca - Dev"
AGENCY_ADDRESS = "Boulevard Mohammed V, Casablanca"
AGENCY_PHONE = "0522000000"

SEED_ACCOUNTS = {
    "admin@smartagency.local": {
        "full_name": "Admin SmartAgency",
        "role": RoleName.ADMIN,
        "employee": None,
    },
    "manager@smartagency.local": {
        "full_name": "Manager Casablanca",
        "role": RoleName.MANAGER,
        "employee": {
            "first_name": "Manager",
            "last_name": "Casablanca",
            "position": "Responsable d'agence",
            "phone": "0600000001",
            "rfid_uid": "RFID-DEV-MANAGER",
            "zones": ("accueil", "direction"),
        },
    },
    "agent@smartagency.local": {
        "full_name": "Agent Accueil",
        "role": RoleName.AGENT,
        "employee": {
            "first_name": "Agent",
            "last_name": "Accueil",
            "position": "Agent d'accueil",
            "phone": "0600000002",
            "rfid_uid": "RFID-DEV-AGENT",
            "zones": ("accueil",),
        },
    },
    "security@smartagency.local": {
        "full_name": "Security Casablanca",
        "role": RoleName.SECURITY,
        "employee": {
            "first_name": "Security",
            "last_name": "Casablanca",
            "position": "Agent de sécurité",
            "phone": "0600000003",
            "rfid_uid": "RFID-DEV-SECURITY",
            "zones": ("accueil", "direction", "technique"),
        },
    },
    "technician@smartagency.local": {
        "full_name": "Technician IoT",
        "role": RoleName.TECHNICIAN,
        "employee": {
            "first_name": "Technician",
            "last_name": "IoT",
            "position": "Technicien IoT",
            "phone": "0600000004",
            "rfid_uid": "RFID-DEV-TECHNICIAN",
            "zones": ("technique",),
        },
    },
}

SERVICE_SPECS = {
    "DEV-VIR": {
        "name": "Virement et consultation",
        "description": "Virements et consultation du compte",
        "point_type": "COUNTER",
        "min_points": 2,
    },
    "DEV-OUV": {
        "name": "Ouverture et gestion de compte",
        "description": "Création et gestion des comptes clients",
        "point_type": "OFFICE",
        "min_points": 1,
    },
    "DEV-CRE": {
        "name": "Crédit et chèques",
        "description": "Demandes de crédit et opérations sur chèques",
        "point_type": "OFFICE",
        "min_points": 1,
    },
}

COUNTER_SPECS = {
    1: {"name": "Guichet virement", "service_code": "DEV-VIR", "point_type": "COUNTER"},
    2: {"name": "Guichet consultation", "service_code": "DEV-VIR", "point_type": "COUNTER"},
    3: {"name": "Bureau ouverture de compte", "service_code": "DEV-OUV", "point_type": "OFFICE"},
    4: {"name": "Bureau crédits et chèques", "service_code": "DEV-CRE", "point_type": "OFFICE"},
}

ZONE_SPECS = {
    "accueil": {"name": "Accueil", "zone_type": "PUBLIC", "is_private": False},
    "direction": {"name": "Bureau de direction", "zone_type": "RESTRICTED", "is_private": True},
    "technique": {"name": "Local technique", "zone_type": "RESTRICTED", "is_private": True},
}


def env_flag(name: str) -> bool:
    return os.getenv(name, "false").strip().lower() in {"1", "true", "yes", "on"}


def get_or_create_role(db, role_name: RoleName) -> Role:
    role = db.scalar(select(Role).where(Role.name == role_name))
    if role is None:
        role = Role(name=role_name, description=f"Role {role_name.value}")
        db.add(role)
        db.flush()
    elif not role.description:
        role.description = f"Role {role_name.value}"
    return role


def get_or_create_agency(db) -> Agency:
    agency = db.scalar(select(Agency).where(Agency.name == AGENCY_NAME))
    if agency is None:
        agency = Agency(
            name=AGENCY_NAME,
            address=AGENCY_ADDRESS,
            phone=AGENCY_PHONE,
            opening_time=time(8, 30),
            closing_time=time(16, 30),
            is_active=True,
        )
        db.add(agency)
        db.flush()
    else:
        agency.address = AGENCY_ADDRESS
        agency.phone = AGENCY_PHONE
        agency.opening_time = time(8, 30)
        agency.closing_time = time(16, 30)
        agency.is_active = True
    return agency


def get_or_create_zone(db, agency: Agency, key: str, spec: dict) -> Zone:
    zone = db.scalar(
        select(Zone).where(Zone.agency_id == agency.id, Zone.name == spec["name"])
    )
    if zone is None:
        zone = Zone(agency_id=agency.id, **spec)
        db.add(zone)
        db.flush()
    else:
        zone.zone_type = spec["zone_type"]
        zone.is_private = spec["is_private"]
    return zone


def get_or_create_service(db, agency: Agency, code: str, spec: dict) -> Service:
    service = db.scalar(
        select(Service).where(Service.agency_id == agency.id, Service.code == code)
    )
    if service is None:
        service = Service(agency_id=agency.id, code=code, **spec)
        db.add(service)
        db.flush()
    else:
        service.name = spec["name"]
        service.description = spec["description"]
        service.point_type = spec["point_type"]
        service.min_points = spec["min_points"]
        service.is_active = True
    return service


def get_or_create_counter(db, agency: Agency, number: int, spec: dict, services: dict[str, Service]) -> Counter:
    counter = db.scalar(
        select(Counter).where(Counter.agency_id == agency.id, Counter.number == number)
    )
    if counter is None:
        counter = Counter(
            agency_id=agency.id,
            number=number,
            name=spec["name"],
            point_type=spec["point_type"],
            service_id=services[spec["service_code"]].id,
            is_open=True,
        )
        db.add(counter)
        db.flush()
    counter.name = spec["name"]
    counter.point_type = spec["point_type"]
    counter.service_id = services[spec["service_code"]].id
    counter.is_open = True
    return counter


def get_or_create_user(db, email: str, spec: dict, roles: dict[RoleName, Role], agency: Agency, password: str) -> User:
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(
            full_name=spec["full_name"],
            email=email,
            password_hash=hash_password(password),
            role=roles[spec["role"]],
            agency=None if spec["role"] == RoleName.ADMIN else agency,
            is_active=True,
        )
        db.add(user)
        db.flush()
    user.full_name = spec["full_name"]
    user.role = roles[spec["role"]]
    user.agency = None if spec["role"] == RoleName.ADMIN else agency
    user.is_active = True
    if env_flag("SEED_RESET_PASSWORD"):
        user.password_hash = hash_password(password)
    return user


def get_or_create_employee(
    db,
    email: str,
    user: User,
    spec: dict,
    agency: Agency,
    zones: dict[str, Zone],
) -> Employee:
    employee_spec = spec["employee"]
    employee = db.scalar(select(Employee).where(Employee.email == email))
    if employee is None:
        employee = Employee(
            agency_id=agency.id,
            email=email,
            first_name=employee_spec["first_name"],
            last_name=employee_spec["last_name"],
            phone=employee_spec["phone"],
            position=employee_spec["position"],
            rfid_uid=employee_spec["rfid_uid"],
            role=spec["role"],
            status=EmployeeStatus.ACTIVE,
            is_active=True,
            hire_date=date.today(),
        )
        db.add(employee)
        db.flush()

    if user.employee is not None and user.employee is not employee:
        user.employee.user = None
    employee.user = user
    employee.agency_id = agency.id
    employee.first_name = employee_spec["first_name"]
    employee.last_name = employee_spec["last_name"]
    employee.phone = employee_spec["phone"]
    employee.position = employee_spec["position"]
    employee.rfid_uid = employee_spec["rfid_uid"]
    employee.role = spec["role"]
    employee.status = EmployeeStatus.ACTIVE
    employee.is_active = True
    employee.hire_date = date.today()
    employee.authorized_zones = [zones[key] for key in employee_spec["zones"]]
    return employee


def get_or_create_device(db, agency: Agency) -> tuple[Device, str]:
    device_id = "access-sensors-1"
    device_key = os.getenv("SEED_DEVICE_KEY", "access-sensors-1-dev-key")
    device = db.scalar(select(Device).where(Device.mqtt_client_id == device_id))
    if device is None:
        device = Device(
            agency_id=agency.id,
            name="Access sensors 1",
            device_type="ACCESS_SENSORS",
            mqtt_client_id=device_id,
            mqtt_topic=f"agency/{agency.id}/device/{device_id}/sensor",
            device_key_hash=hash_device_key(device_key),
            status=DeviceStatus.OFFLINE,
        )
        db.add(device)
        db.flush()
    device.agency_id = agency.id
    device.name = "Access sensors 1"
    device.device_type = "ACCESS_SENSORS"
    device.mqtt_topic = f"agency/{agency.id}/device/{device_id}/sensor"
    device.device_key_hash = hash_device_key(device_key)
    device.status = DeviceStatus.OFFLINE
    return device, device_key


def get_or_create_threshold(db, device: Device, sensor_type: str, unit: str, warning: float, critical: float) -> SensorThreshold:
    threshold = db.scalar(
        select(SensorThreshold).where(
            SensorThreshold.device_id == device.id,
            SensorThreshold.sensor_type == sensor_type,
        )
    )
    if threshold is None:
        threshold = SensorThreshold(device_id=device.id, sensor_type=sensor_type)
        db.add(threshold)
    threshold.unit = unit
    threshold.warning_max = warning
    threshold.critical_max = critical
    threshold.is_active = True
    return threshold


def get_or_create_visitor(db, agency: Agency, full_name: str, identity_reference: str) -> Visitor:
    visitor = db.scalar(
        select(Visitor).where(
            Visitor.agency_id == agency.id,
            Visitor.identity_reference == identity_reference,
        )
    )
    if visitor is None:
        visitor = Visitor(agency_id=agency.id, full_name=full_name)
        db.add(visitor)
        db.flush()
    visitor.full_name = full_name
    visitor.phone = "0612345678"
    visitor.identity_reference = identity_reference
    return visitor


def get_or_create_ticket(
    db,
    visitor: Visitor,
    service: Service,
    ticket_number: str,
    status: TicketStatus,
    counter: Counter | None = None,
) -> Ticket:
    ticket = db.scalar(select(Ticket).where(Ticket.ticket_number == ticket_number))
    if ticket is None:
        ticket = Ticket(visitor_id=visitor.id, ticket_number=ticket_number)
        db.add(ticket)
        db.flush()
    ticket.visitor_id = visitor.id
    ticket.service_id = service.id
    ticket.counter_id = counter.id if counter else None
    ticket.service_type = service.name
    ticket.status = status
    ticket.created_at = datetime.now(timezone.utc) - timedelta(minutes=20)
    ticket.called_at = (
        datetime.now(timezone.utc) - timedelta(minutes=10)
        if status in {TicketStatus.CALLED, TicketStatus.COMPLETED}
        else None
    )
    ticket.completed_at = (
        datetime.now(timezone.utc) - timedelta(minutes=3)
        if status == TicketStatus.COMPLETED
        else None
    )
    return ticket


def get_or_create_attendance(db, employee: Employee) -> Attendance:
    start_of_day = datetime.combine(date.today(), time.min, tzinfo=timezone.utc)
    attendance = db.scalar(
        select(Attendance).where(
            Attendance.employee_id == employee.id,
            Attendance.check_in >= start_of_day,
        )
    )
    if attendance is None:
        attendance = Attendance(
            employee_id=employee.id,
            check_in=datetime.now(timezone.utc) - timedelta(hours=1),
            check_out=None,
            method=AttendanceMethod.RFID,
        )
        db.add(attendance)
    return attendance


def get_or_create_camera(db, agency: Agency, name: str, stream_url: str) -> Camera:
    camera = db.scalar(select(Camera).where(Camera.name == name))
    if camera is None:
        camera = Camera(agency_id=agency.id, name=name)
        db.add(camera)
        db.flush()
    camera.agency_id = agency.id
    camera.stream_url = stream_url
    camera.status = DeviceStatus.OFFLINE
    return camera


def seed() -> dict[str, str]:
    password = os.getenv("SEED_PASSWORD", "Admin12345")
    device_key = os.getenv("SEED_DEVICE_KEY", "access-sensors-1-dev-key")

    with SessionLocal() as db:
        try:
            roles = {role_name: get_or_create_role(db, role_name) for role_name in RoleName}
            agency = get_or_create_agency(db)
            zones = {
                key: get_or_create_zone(db, agency, key, spec)
                for key, spec in ZONE_SPECS.items()
            }
            services = {
                code: get_or_create_service(db, agency, code, spec)
                for code, spec in SERVICE_SPECS.items()
            }
            counters = {
                number: get_or_create_counter(db, agency, number, spec, services)
                for number, spec in COUNTER_SPECS.items()
            }

            users: dict[str, User] = {}
            employees: dict[str, Employee] = {}
            for email, spec in SEED_ACCOUNTS.items():
                user = get_or_create_user(db, email, spec, roles, agency, password)
                users[email] = user
                if spec["employee"] is not None:
                    employees[email] = get_or_create_employee(db, email, user, spec, agency, zones)
            users["agent@smartagency.local"].counter_id = counters[1].id

            device, device_key = get_or_create_device(db, agency)
            get_or_create_threshold(db, device, "temperature", "C", 28.0, 35.0)
            get_or_create_threshold(db, device, "humidity", "%", 70.0, 85.0)
            get_or_create_threshold(db, device, "gas_co", "ppm", 10.0, 20.0)

            camera_1 = get_or_create_camera(db, agency, "cam1", "rtsp://127.0.0.1:8554/cam1")
            get_or_create_camera(db, agency, "cam2", "rtsp://127.0.0.1:8554/cam2")

            weapon_threshold = db.scalar(
                select(AIAlertThreshold).where(AIAlertThreshold.alert_type == "weapon")
            )
            if weapon_threshold is None:
                weapon_threshold = AIAlertThreshold(alert_type="weapon")
                db.add(weapon_threshold)
            weapon_threshold.confidence = 0.6

            visitor_1 = get_or_create_visitor(db, agency, "Client Test", "CIN-DEV-001")
            visitor_2 = get_or_create_visitor(db, agency, "Sara Visiteuse", "CIN-DEV-002")
            get_or_create_ticket(db, visitor_1, services["DEV-VIR"], "DEV-VIR-001", TicketStatus.WAITING)
            get_or_create_ticket(
                db,
                visitor_2,
                services["DEV-OUV"],
                "DEV-OUV-001",
                TicketStatus.CALLED,
                counters[3],
            )
            get_or_create_ticket(
                db,
                visitor_1,
                services["DEV-CRE"],
                "DEV-CRE-001",
                TicketStatus.COMPLETED,
                counters[4],
            )

            get_or_create_attendance(db, employees["security@smartagency.local"])

            existing_alert = db.scalar(
                select(Alert).where(
                    Alert.agency_id == agency.id,
                    Alert.title == "Alerte de test SmartAgency",
                )
            )
            if existing_alert is None:
                existing_alert = Alert(agency_id=agency.id, title="Alerte de test SmartAgency")
                db.add(existing_alert)
            existing_alert.camera_id = camera_1.id
            existing_alert.device_id = device.id
            existing_alert.alert_type = "weapon"
            existing_alert.message = "Alerte de démonstration pour le dashboard"
            existing_alert.severity = AlertSeverity.MEDIUM
            existing_alert.status = AlertStatus.OPEN
            existing_alert.resolved_at = None

            db.commit()
        except Exception:
            db.rollback()
            raise

    return {
        "agency": AGENCY_NAME,
        "admin_email": "admin@smartagency.local",
        "password": password,
        "device_id": "access-sensors-1",
        "device_key": device_key,
    }


if __name__ == "__main__":
    result = seed()
    print("Development data seeded successfully.")
    print(f"Agency: {result['agency']}")
    print(f"Admin login: {result['admin_email']}")
    print(f"Password: {result['password']}")
    print(f"Device ID: {result['device_id']}")
    print(f"Device key: {result['device_key']}")
