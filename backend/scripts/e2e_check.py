"""End-to-end pass over Phases B-T. Real Postgres + real MQTT broker (the docker
containers from the README); only the AI service HTTP calls are faked.

    cd core/backend && PYTHONPATH=. python scripts/e2e_check.py

Needs the browsertest-*@smartagency-test.com accounts and the seeded dev agency
with a camera. Stop any running uvicorn first: its health monitor would raise
AI-down alerts against the same database. Creates tagged test rows and removes
them at the end; the agency's kiosk zone and lockdown toggle are restored.
"""
import json, time, uuid, sys
from datetime import datetime, timezone
from unittest import mock

import paho.mqtt.client as mqtt
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.main import app
from app.database.connection import SessionLocal
from app.core.device_security import hash_device_key
from app.models.entities import *  # noqa
import time
from datetime import datetime, timezone
import app.ai_alerts.consumer as weapon_mod
import app.services.people_tracking as pt
import app.services.visitor_recognition as vr
import app.services.offboarding_service as off
import app.services.notification_service as ns
from app.ai_alerts.fire_consumer import fire_alert_consumer
from app.mqtt.sensor_consumer import sensor_consumer
from app.services.health_monitor import HealthMonitor, AI_SERVICE
from app.services.iot_service import process_sensor_payload
from app.schemas.sensor import SensorPayload

results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))

class Resp:
    def __init__(self, body, status=200): self._b, self.status_code = body, status
    def json(self): return self._b
    def raise_for_status(self): pass

ZONES = {
    "e2e-kiosk": {"mode": "world", "polygon_m": [[1, 4], [4, 4], [4, 7], [1, 7]], "converted_from": {"camera": "cam1"}},
    "e2e-badge": {"mode": "world", "polygon_m": [[1, 4], [4, 4], [4, 7], [1, 7]]},
}
deleted_faces = []
def fake_forward(method, path, **kw):
    if path == "/zoning/zones": return Resp(ZONES)
    if path == "/face/capture": return Resp({"embedding": [0.1] * 512, "timed_out": False})
    if path == "/face/faces" and method == "GET": return Resp([{"name": "E2E Leaver"}])
    if path.startswith("/face/faces/") and method == "DELETE":
        deleted_faces.append(path); return Resp({"deleted": True})
    return Resp({}, 404)

def login(c, email):
    r = c.post("/api/auth/login", json={"email": email, "password": "TestPass123!"})
    assert r.status_code == 200, (email, r.text)
    return {"Authorization": "Bearer " + r.json()["access_token"]}, r.json()["user"]

c = TestClient(app)
db = SessionLocal()
cam = db.scalar(select(Camera)); ag = db.get(Agency, cam.agency_id)
tag = uuid.uuid4().hex[:6]
started = datetime.now(timezone.utc)
tid = vid = None
created = []   # (model, id) for cleanup
orig = dict(kiosk=ag.kiosk_zone_name, lock=ag.weapon_lockdown_enabled)

admin_h, _ = login(c, "browsertest-admin@smartagency-test.com")
mgr_h, mgr = login(c, "browsertest-manager@smartagency-test.com")
sec_h, _ = login(c, "browsertest-security@smartagency-test.com")
agent_h, _ = login(c, "browsertest-agent@smartagency-test.com")

# ---- fixtures -------------------------------------------------------------
KEY = "e2e-key-" + tag
kiosk = Device(agency_id=ag.id, name="E2E kiosk", device_type="KIOSK", mqtt_client_id="e2e-kiosk-" + tag, mqtt_topic="x", device_key_hash=hash_device_key(KEY))
badge = Device(agency_id=ag.id, name="E2E reader", device_type="RFID", mqtt_client_id="e2e-reader-" + tag, mqtt_topic="x", device_key_hash=hash_device_key(KEY), badge_zone_name="e2e-badge")
door = Device(agency_id=ag.id, name="E2E door", device_type="DOOR", mqtt_client_id="e2e-door-" + tag, mqtt_topic="x")
sens = Device(agency_id=ag.id, name="E2E gas", device_type="SENSOR", mqtt_client_id="e2e-gas-" + tag, mqtt_topic="x")
db.add_all([kiosk, badge, door, sens]); db.flush()
db.add(SensorThreshold(device_id=sens.id, sensor_type="gas_co", unit="ppm", warning_max=100, critical_max=200))
ag.kiosk_zone_name = "e2e-kiosk"
service = db.scalar(select(Service).where(Service.agency_id == ag.id, Service.is_active.is_(True)))
leaver_user = User(email=f"e2e-leaver-{tag}@smartagency-test.com", full_name="E2E Leaver", password_hash="x", role_id=db.scalar(select(Role.id).where(Role.name == RoleName.AGENT)), agency_id=ag.id, is_active=True)
db.add(leaver_user); db.flush()
emp = Employee(agency_id=ag.id, user_id=leaver_user.id, first_name="E2E", last_name="Leaver", email=f"e2e-emp-{tag}@smartagency-test.com", rfid_uid="E2E" + tag, is_active=True)
db.add(emp); db.commit()
dev_ids = [kiosk.id, badge.id, door.id, sens.id]
for em in ("admin", "manager", "security"):
    uid = db.scalar(select(User.id).where(User.email == f"browsertest-{em}@smartagency-test.com"))
    db.add(PushSubscription(user_id=uid, endpoint=f"https://push.invalid/{tag}/{em}", p256dh="p", auth="a"))
db.commit()

# ---- MQTT listener for door commands --------------------------------------
cmds = []
sub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
sub.on_message = lambda cl, u, m: cmds.append(json.loads(m.payload)["action"] if m.topic.endswith(door.mqtt_client_id + "/control") else None)
sub.connect("127.0.0.1", 1884); sub.subscribe("agency/+/device/+/control"); sub.loop_start()
sensor_consumer.start(); time.sleep(2)
check("backend MQTT client connected", sensor_consumer.client and sensor_consumer.client.is_connected())
def door_cmds(): return [x for x in cmds if x]

push_calls, email_calls = [], []
try:
    with mock.patch.object(pt, "forward", fake_forward), mock.patch.object(vr, "forward", fake_forward), \
         mock.patch.object(off, "forward", fake_forward), mock.patch.object(off, "raise_for_ai_status", lambda r: None), \
         mock.patch.object(pt, "raise_for_ai_status", lambda r: None), \
         mock.patch.object(ns, "push_configured", lambda: True), \
         mock.patch.object(ns, "_send_push", lambda s, p: push_calls.append((s.user_id, p["alert_type"]))), \
         mock.patch.object(ns, "email_configured", lambda: True), \
         mock.patch.object(ns, "_send_email", lambda to, s, b: email_calls.append(to)):

        # ---- B/C/D: kiosk ticket -> tracking, wanted tag, face --------------
        pt.people_track_tracker.process_message({"type": "tracks", "tracks": [{"id": 7, "x": 210.5, "y": 533.0}, {"id": 8, "x": 900.0, "y": 900.0}]})
        wanted = Alert(agency_id=ag.id, camera_id=cam.id, alert_type="wanted", title="w", message="m", severity=AlertSeverity.CRITICAL, status=AlertStatus.OPEN)
        db.add(wanted); db.commit()
        with mock.patch.object(pt, "camera_id_by_name", lambda d, n: cam.id):
            r = c.post("/internal/tickets/walk-in", headers={"X-Device-Key": KEY}, json={"agency_id": ag.id, "device_id": kiosk.mqtt_client_id, "service_id": service.id})
        check("walk-in ticket created", r.status_code == 201, r.text)
        tid = r.json()["ticket_id"]; db.expire_all(); vid = db.get(Ticket, tid).visitor_id
        t = db.get(Ticket, tid)
        check("B: ticket linked to the tracked person in the kiosk zone", t.tracking_id == "7", t.tracking_id)
        check("C: open wanted alert tagged with the ticket", db.get(Alert, wanted.id).ticket_id == tid)
        check("D: visitor face embedding stored", db.get(Visitor, t.visitor_id).face_embedding is not None)

        # ---- F: badge scan + failure log ------------------------------------
        r = c.post("/internal/attendance/check-rfid", headers={"X-Device-Key": KEY}, json={"agency_id": ag.id, "device_id": badge.mqtt_client_id, "employee_rfid": emp.rfid_uid})
        check("badge scan accepted", r.status_code == 200 and r.json()["valid"], r.text)
        db.expire_all()
        check("F: employee linked to tracked person at the reader zone", db.get(Employee, emp.id).tracking_id == "7")
        for _ in range(3):
            c.post("/internal/attendance/check-rfid", headers={"X-Device-Key": KEY}, json={"agency_id": ag.id, "device_id": badge.mqtt_client_id, "employee_rfid": "NOPE" + tag})
        n = db.scalars(select(AccessFailure).where(AccessFailure.scanned_uid == "NOPE" + tag)).all()
        check("P: failed scans logged", len(n) == 3, len(n))
        r = c.get(f"/api/agencies/{ag.id}/insights/access", headers=mgr_h)
        check("P: access insights endpoint ok for manager", r.status_code == 200, r.text[:100])

        # ---- H: weapon lockdown, G: notifications ---------------------------
        r = c.put(f"/api/agencies/{ag.id}", headers=mgr_h, json={"weapon_lockdown_enabled": True})
        check("H: manager enables lockdown", r.status_code == 200)
        weapon_mod.LOCKDOWN_CONFIRM_SECONDS = 1.5
        wc = weapon_mod.WeaponAlertConsumer()
        wc.process_message({"type": "update", "camera": cam.name, "detections": [{"class": "pistol", "confidence": 0.9}]})
        time.sleep(0.5)
        check("G: weapon alert notified on first detection (push to ADMIN/MANAGER/SECURITY)", len(push_calls) >= 3 and all(a == "weapon" for _, a in push_calls), push_calls)
        n_push = len(push_calls)
        wc.process_message({"type": "update", "camera": cam.name, "detections": [{"class": "pistol", "confidence": 0.8}, {"class": "knife", "confidence": 0.7}]})
        time.sleep(0.3)
        check("G: refreshed alert does NOT notify again", len(push_calls) == n_push)
        check("H: no lock before confirm window", not door_cmds())
        time.sleep(2.5)
        check("H: doors locked once the weapon persisted", door_cmds() == ["lock"], door_cmds())
        # ---- I: fire during lockdown unlocks --------------------------------
        fire_alert_consumer.process_message({"type": "update", "camera": cam.name, "detections": [{"class": "fire", "confidence": 0.9}]})
        time.sleep(1.0)
        check("I: fire unlocks doors", door_cmds()[-1:] == ["unlock"], door_cmds())
        wc.process_message({"type": "update", "camera": cam.name, "detections": []})
        time.sleep(0.3)
        # new weapon episode while fire open -> skipped
        wc.process_message({"type": "update", "camera": cam.name, "detections": [{"class": "pistol", "confidence": 0.9}]})
        time.sleep(2.5)
        check("H/I: lock skipped while fire is open", door_cmds() == ["lock", "unlock"], door_cmds())
        skipped = db.scalars(select(AuditLog).where(AuditLog.action == "auto_lock_skipped", AuditLog.agency_id == ag.id)).all()
        check("H/I: skip is audited", len(skipped) >= 1)
        wc.process_message({"type": "update", "camera": cam.name, "detections": []})
        fire_alert_consumer.process_message({"type": "update", "camera": cam.name, "detections": []})
        # ---- I: gas -----------------------------------------------------------
        before = len(door_cmds())
        process_sensor_payload(db, ag.id, sens.mqtt_client_id, SensorPayload(readings=[{"sensor_type": "gas_co", "value": 350, "unit": "ppm"}], timestamp=datetime.now(timezone.utc)))
        time.sleep(1.0)
        check("I: critical gas unlocks doors", door_cmds()[before:] == ["unlock"], door_cmds())
        gas = db.scalar(select(Alert).where(Alert.device_id == sens.id, Alert.alert_type == "gas_co"))
        check("I: gas alert CRITICAL + notified", gas is not None and gas.severity == AlertSeverity.CRITICAL and any(a == "gas_co" for _, a in push_calls))

        # ---- G: email fallback for users without a subscription ----------------
        check("G: email fallback used for recipients with no push subscription (e.g. other ADMIN/SECURITY users)", len(email_calls) >= 1, email_calls)
        mgr_other = db.scalars(select(User).where(User.agency_id != ag.id, User.is_active.is_(True))).all()
        check("G: no notification to other agencies' staff", not any(e in [u.email for u in mgr_other if u.role.name != RoleName.ADMIN] for e in email_calls))

        # ---- J: health monitor ----------------------------------------------------
        hm = HealthMonitor()
        hm.record(AI_SERVICE, False, 0.0); hm.record(AI_SERVICE, False, 100.0)
        down = db.scalar(select(Alert).where(Alert.agency_id == ag.id, Alert.alert_type == "ai_service_down", Alert.status == AlertStatus.OPEN))
        check("J: AI-down meta-alert opens after grace", down is not None)
        hm.record(AI_SERVICE, True, 120.0); db.expire_all()
        check("J: resolves on recovery", db.get(Alert, down.id).status == AlertStatus.RESOLVED)

        # ---- L/M: staffing + queue signal via agents endpoint ------------------
        r = c.get(f"/api/agencies/{ag.id}/agents", headers=mgr_h)
        check("L: agents list with attendance ok", r.status_code == 200, r.text[:100])

        # ---- N/O/S/T: insights ----------------------------------------------------
        for name, path, h in [
            ("N trends", f"/api/agencies/{ag.id}/insights/trends", mgr_h),
            ("O device uptime", f"/api/agencies/{ag.id}/insights/devices", mgr_h),
            ("S branches (admin)", "/api/insights/branches", admin_h),
            ("T rollup (admin)", f"/api/reports/branches?start={datetime.now(timezone.utc).date()}&end={datetime.now(timezone.utc).date()}", admin_h),
            ("T agency report (manager)", f"/api/agencies/{ag.id}/report?start={datetime.now(timezone.utc).date()}&end={datetime.now(timezone.utc).date()}", mgr_h),
            ("R setup status", f"/api/agencies/{ag.id}/setup-status", mgr_h),
        ]:
            r = c.get(path, headers=h)
            check(f"{name} 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        for name, path, h in [("S branches blocked for manager", "/api/insights/branches", mgr_h), ("T rollup blocked for security", "/api/reports/branches?start=2026-10-01&end=2026-10-01", sec_h),
                              ("T report blocked for agent", f"/api/agencies/{ag.id}/report?start=2026-10-01&end=2026-10-01", agent_h)]:
            r = c.get(path, headers=h); check(name, r.status_code == 403, r.status_code)
        r = c.get(f"/api/agencies/{ag.id}/report?start=2026-10-05&end=2026-10-01", headers=mgr_h); check("T: reversed range 422", r.status_code == 422)

        # ---- K: offboarding --------------------------------------------------------
        r = c.put(f"/api/employees/{emp.id}", headers=mgr_h, json={"status": "INACTIVE"})
        check("K: employee set INACTIVE", r.status_code == 200, r.text[:120])
        db.expire_all()
        check("K: linked login disabled", db.get(User, leaver_user.id).is_active is False)
        check("K: face removed from gallery", any("E2E%20Leaver" in p or "E2E Leaver" in p for p in deleted_faces), deleted_faces)
        check("K: offboarding audited", db.scalar(select(AuditLog).where(AuditLog.action == "employee_offboarded", AuditLog.entity_id == emp.id)) is not None)
finally:
    sensor_consumer.stop(); sub.loop_stop()
    db.rollback(); db.expire_all()
    a = db.get(Agency, ag.id); a.kiosk_zone_name = orig["kiosk"]; a.weapon_lockdown_enabled = orig["lock"]
    db.commit()
    try:
        db.expire_all()
        for model, col, ids in [(AccessFailure, AccessFailure.device_id, dev_ids), (SensorReading, SensorReading.device_id, dev_ids), (DeviceStatusSample, DeviceStatusSample.device_id, dev_ids), (SensorThreshold, SensorThreshold.device_id, dev_ids)]:
            db.execute(model.__table__.delete().where(col.in_(ids)))
        db.execute(Alert.__table__.delete().where(Alert.device_id.in_(dev_ids)))
        db.execute(Alert.__table__.delete().where(Alert.agency_id == ag.id, Alert.alert_type.in_(("wanted", "weapon", "fire", "gas_co")), Alert.created_at >= started))
        db.execute(PushSubscription.__table__.delete().where(PushSubscription.endpoint.like(f"https://push.invalid/{tag}/%")))
        db.execute(Attendance.__table__.delete().where(Attendance.employee_id == emp.id))
        db.execute(Ticket.__table__.delete().where(Ticket.id == tid))
        db.execute(Visitor.__table__.delete().where(Visitor.id == vid))
        db.execute(Device.__table__.delete().where(Device.id.in_(dev_ids)))
        db.execute(AuditLog.__table__.delete().where(AuditLog.entity_id.in_([emp.id])))
        db.execute(Employee.__table__.delete().where(Employee.id == emp.id))
        db.execute(User.__table__.delete().where(User.id == leaver_user.id))
        db.commit()
        print("cleanup: test rows removed, agency settings restored")
    except Exception as exc:
        db.rollback(); print("cleanup partial:", exc)

bad = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(bad)}/{len(results)} passed"); sys.exit(1 if bad else 0)
