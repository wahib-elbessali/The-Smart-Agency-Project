"""The branch setup checklist: every item derived from real rows, and the three
AI-backed items say "unknown" (never "todo") when the AI service cannot answer."""
from datetime import time

import httpx
import pytest
from fastapi import HTTPException

from app.models.entities import (
    Agency,
    Camera,
    Counter,
    Device,
    Employee,
    RoleName,
    SensorThreshold,
    Service,
)
from app.services import setup_status as ss

from .conftest import make_user


class FakeAI:
    def __init__(self):
        self.replies = {}

    def __call__(self, method, path, **_):
        reply = self.replies.get(path, (200, {} if path != "/face/faces" else []))
        if isinstance(reply, Exception):
            raise reply
        return httpx.Response(reply[0], json=reply[1])


@pytest.fixture()
def ai(monkeypatch):
    fake = FakeAI()
    monkeypatch.setattr(ss, "forward", fake)
    return fake


def status(db, agency):
    return {item.key: item for item in ss.compute_setup_status(db, agency)}


def test_an_empty_branch_has_everything_to_do(db, agency, ai):
    items = status(db, agency)
    assert [i.status for i in items.values()].count("done") == 0
    assert items["calibration"].status == "todo"  # the AI answered, with nothing


def test_each_item_turns_done_from_its_own_rows(db, roles, agency, ai):
    agency.opening_time, agency.closing_time = time(8, 0), time(16, 0)
    agency.ticket_template = [{"type": "text", "content": "Hello"}]
    service = Service(agency_id=agency.id, code="VIR", name="Virement")
    db.add(service)
    db.flush()
    counter = Counter(agency_id=agency.id, number=1, name="G1", service_id=service.id)
    device = Device(agency_id=agency.id, name="d", device_type="SENSOR", mqtt_client_id="d1", mqtt_topic="t")
    db.add_all([counter, device, Camera(agency_id=agency.id, name="cam1", stream_url="rtsp://x"),
                Employee(agency_id=agency.id, first_name="Sara", last_name="Ali", rfid_uid="04AA")])
    db.flush()
    db.add(SensorThreshold(device_id=device.id, sensor_type="temperature", is_active=True))
    agent = make_user(db, roles, RoleName.AGENT, agency.id, "agent@x")
    agent.counter_id = counter.id
    db.commit()

    items = status(db, agency)

    for key in ("hours", "devices", "cameras", "employees", "badges", "logins", "services",
                "counters", "assigned", "ticket_layout", "thresholds"):
        assert items[key].status == "done", key


def test_hours_must_close_after_they_open(db, agency, ai):
    agency.opening_time, agency.closing_time = time(16, 0), time(8, 0)
    db.commit()
    assert status(db, agency)["hours"].status == "todo"


def test_a_counter_without_a_service_does_not_count(db, agency, ai):
    db.add(Counter(agency_id=agency.id, number=1, name="G1"))
    db.commit()
    assert status(db, agency)["counters"].status == "todo"


def test_an_inactive_agent_or_threshold_does_not_count(db, roles, agency, ai):
    make_user(db, roles, RoleName.AGENT, agency.id, "gone@x", active=False)
    device = Device(agency_id=agency.id, name="d", device_type="SENSOR", mqtt_client_id="d1", mqtt_topic="t")
    db.add(device)
    db.flush()
    db.add(SensorThreshold(device_id=device.id, sensor_type="temperature", is_active=False))
    db.commit()
    items = status(db, agency)
    assert items["logins"].status == "todo"
    assert items["thresholds"].status == "todo"


def test_another_branchs_rows_do_not_count(db, roles, agency, ai):
    other = Agency(name="Branch B")
    db.add(other)
    db.flush()
    db.add_all([Camera(agency_id=other.id, name="theirs", stream_url="rtsp://x"),
                Employee(agency_id=other.id, first_name="A", last_name="B", rfid_uid="1")])
    db.commit()
    items = status(db, agency)
    assert items["cameras"].status == "todo"
    assert items["employees"].status == "todo"


def test_vision_items_follow_this_branchs_cameras_only(db, agency, ai):
    db.add(Camera(agency_id=agency.id, name="cam1", stream_url="rtsp://x"))
    db.commit()
    ai.replies["/calibration"] = (200, {"cam1": {"diagnostics": {"aligned": True}}})
    ai.replies["/zoning/zones"] = (200, {"hall": {"mode": "pixel", "camera": "cam1"}})
    items = status(db, agency)
    assert (items["calibration"].status, items["zones"].status) == ("done", "done")

    ai.replies["/calibration"] = (200, {"someone-elses": {"diagnostics": {"aligned": True}}})
    ai.replies["/zoning/zones"] = (200, {"hall": {"mode": "pixel", "camera": "someone-elses"}})
    items = status(db, agency)
    assert (items["calibration"].status, items["zones"].status) == ("todo", "todo")


def test_a_world_zone_is_attributed_through_its_source_camera(db, agency, ai):
    db.add(Camera(agency_id=agency.id, name="cam1", stream_url="rtsp://x"))
    db.commit()
    ai.replies["/zoning/zones"] = (200, {"hall": {"mode": "world", "converted_from": {"camera": "cam1"}}})
    assert status(db, agency)["zones"].status == "done"


def test_a_face_counts_when_an_employee_name_is_in_the_gallery(db, agency, ai):
    db.add(Employee(agency_id=agency.id, first_name="Sara", last_name="Ali"))
    db.commit()
    ai.replies["/face/faces"] = (200, [{"name": "Sara Ali", "embeddings": []}])
    assert status(db, agency)["faces"].status == "done"
    ai.replies["/face/faces"] = (200, [{"name": "Somebody Else", "embeddings": []}])
    assert status(db, agency)["faces"].status == "todo"


@pytest.mark.parametrize(
    "reply",
    [HTTPException(503, "down"), (500, {"detail": "boom"}), (200, ["not", "a", "dict"])],
)
def test_ai_items_are_unknown_not_todo_when_the_ai_cannot_answer(db, agency, ai, reply):
    ai.replies["/calibration"] = reply
    ai.replies["/zoning/zones"] = reply
    ai.replies["/face/faces"] = reply if not isinstance(reply, tuple) or reply[0] != 200 else (200, {"not": "a list"})
    items = status(db, agency)
    assert {items[k].status for k in ("calibration", "zones", "faces")} == {"unknown"}
    assert "AI service did not answer" in items["calibration"].detail


def test_kiosk_zone_and_badge_zone_are_on_the_checklist(db, agency, ai):
    items = status(db, agency)
    assert items["kiosk_zone"].status == "todo" and items["badge_zone"].status == "todo"
    agency.kiosk_zone_name = "Kiosk zone"
    db.add(Device(agency_id=agency.id, name="Portique", device_type="RFID_READER", mqtt_client_id="g1",
                  mqtt_topic="t", badge_zone_name="Gate"))
    db.commit()
    items = status(db, agency)
    assert items["kiosk_zone"].status == "done"
    assert items["badge_zone"].status == "done" and items["badge_zone"].detail == "Portique"
