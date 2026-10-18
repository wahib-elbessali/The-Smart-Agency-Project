import time

import pytest

import app.services.notification_service as ns
from app.models.entities import AlertSeverity, AlertStatus, PushSubscription, RoleName
from tests.conftest import make_alert, make_user


@pytest.fixture()
def staff(db, roles, agency):
    from app.models.entities import Agency

    other = Agency(name="Branch B")
    db.add(other)
    db.commit()
    return {
        "admin": make_user(db, roles, RoleName.ADMIN, None, "admin@t.com"),
        "manager": make_user(db, roles, RoleName.MANAGER, agency.id, "mgr@t.com"),
        "security": make_user(db, roles, RoleName.SECURITY, agency.id, "sec@t.com"),
        "agent": make_user(db, roles, RoleName.AGENT, agency.id, "agent@t.com"),
        "other_mgr": make_user(db, roles, RoleName.MANAGER, other.id, "other@t.com"),
        "inactive": make_user(db, roles, RoleName.SECURITY, agency.id, "off@t.com", active=False),
    }


@pytest.fixture()
def outbox(monkeypatch):
    box = {"push": [], "email": []}
    monkeypatch.setattr(ns, "push_configured", lambda: True)
    monkeypatch.setattr(ns, "email_configured", lambda: True)
    monkeypatch.setattr(
        ns, "_send_push", lambda sub, payload: box["push"].append((sub.user_id, payload))
    )
    monkeypatch.setattr(ns, "_send_email", lambda to, subject, body: box["email"].append((to, body)))
    return box


def test_recipients_are_admins_plus_own_branch_manager_and_security(db, agency, staff):
    emails = {u.email for u in ns.recipients_for(db, agency.id)}
    assert emails == {"admin@t.com", "mgr@t.com", "sec@t.com"}


def test_push_to_subscribed_and_email_to_the_rest(db, agency, staff, outbox):
    db.add(PushSubscription(user_id=staff["manager"].id, endpoint="e1", p256dh="p", auth="a"))
    db.commit()
    alert = make_alert(db, agency.id, "weapon")
    ns._deliver([alert.id])
    assert [uid for uid, _ in outbox["push"]] == [staff["manager"].id]
    assert {to for to, _ in outbox["email"]} == {"admin@t.com", "sec@t.com"}


def test_gone_subscription_is_deleted_and_falls_back_to_email(db, agency, staff, outbox, monkeypatch):
    db.add(PushSubscription(user_id=staff["manager"].id, endpoint="dead", p256dh="p", auth="a"))
    db.commit()

    def gone(sub, payload):
        raise ns.PushGone()

    monkeypatch.setattr(ns, "_send_push", gone)
    alert = make_alert(db, agency.id, "weapon")
    ns._deliver([alert.id])
    assert db.query(PushSubscription).count() == 0
    assert "mgr@t.com" in {to for to, _ in outbox["email"]}


def test_non_critical_alerts_are_not_notified(db, agency, staff, outbox):
    alert = make_alert(db, agency.id, "temperature", severity=AlertSeverity.HIGH)
    ns._deliver([alert.id])
    assert outbox["push"] == [] and outbox["email"] == []


def test_one_failing_recipient_does_not_stop_the_others(db, agency, staff, outbox, monkeypatch):
    def flaky(to, subject, body):
        if to == "admin@t.com":
            raise OSError("smtp down")
        outbox["email"].append((to, body))

    monkeypatch.setattr(ns, "_send_email", flaky)
    alert = make_alert(db, agency.id, "weapon")
    ns._deliver([alert.id])
    assert {to for to, _ in outbox["email"]} == {"mgr@t.com", "sec@t.com"}


def test_weapon_notification_says_lock_is_held_back_when_fire_is_open(db, agency, staff, outbox):
    make_alert(db, agency.id, "fire")
    alert = make_alert(db, agency.id, "weapon")
    ns._deliver([alert.id])
    body = outbox["email"][0][1]
    assert "fire alert is also open" in body


def test_fire_and_gas_label_each_other_as_corroborated(db, agency, staff, outbox):
    make_alert(db, agency.id, "gas_co")
    alert = make_alert(db, agency.id, "fire")
    ns._deliver([alert.id])
    assert "also open in this agency: gas_co" in outbox["email"][0][1]


def test_resolved_counterpart_does_not_corroborate(db, agency, staff, outbox):
    make_alert(db, agency.id, "gas_co", status=AlertStatus.RESOLVED)
    alert = make_alert(db, agency.id, "fire")
    ns._deliver([alert.id])
    assert "also open in this agency" not in outbox["email"][0][1]


def test_notify_returns_immediately_even_when_delivery_is_slow(monkeypatch):
    started = []
    monkeypatch.setattr(ns, "_deliver", lambda ids: (started.append(ids), time.sleep(1.0)))
    begin = time.monotonic()
    ns.notify_critical_alerts(["a1"])
    assert time.monotonic() - begin < 0.5


def test_disabled_notifications_do_nothing(monkeypatch):
    called = []
    monkeypatch.setattr(ns, "_deliver", lambda ids: called.append(ids))
    monkeypatch.setattr(ns.settings, "notifications_enabled", False)
    ns.notify_critical_alerts(["a1"])
    time.sleep(0.1)
    assert called == []
