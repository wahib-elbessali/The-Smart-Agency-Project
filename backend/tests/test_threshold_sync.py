"""Weapon/wanted thresholds: stored in Postgres, applied to the AI service live,
and pushed back whenever the AI service (re)starts."""
import httpx
import pytest
from fastapi import HTTPException

from app.ai_alerts import thresholds
from app.ai_alerts.classifier import (
    DEFAULT_WEAPON_THRESHOLD,
    definir_seuil_confiance_arme,
    get_seuil_confiance_arme,
)
from app.models.entities import AIAlertThreshold


class FakeAI:
    def __init__(self):
        self.calls = []
        self.reply = (200, {})  # (status, body) for the next call, or an exception

    def __call__(self, method, path, json=None, **_):
        self.calls.append((method, path, json))
        if isinstance(self.reply, Exception):
            raise self.reply
        status, body = self.reply
        return httpx.Response(status, json=body)


@pytest.fixture()
def ai(monkeypatch, factory):
    fake = FakeAI()
    monkeypatch.setattr(thresholds, "forward", fake)
    definir_seuil_confiance_arme(DEFAULT_WEAPON_THRESHOLD)
    yield fake
    definir_seuil_confiance_arme(DEFAULT_WEAPON_THRESHOLD)


def row(db, alert_type):
    db.expire_all()
    return db.query(AIAlertThreshold).filter_by(alert_type=alert_type).one_or_none()


@pytest.mark.parametrize(
    "alert_type,value,ok",
    [("weapon", 0, False), ("weapon", 0.01, True), ("weapon", 1, True), ("weapon", 1.01, False),
     ("wanted", 0.24, False), ("wanted", 0.25, True), ("weapon", True, False), ("wanted", "0.5", False)],
)
def test_bounds_match_the_ai_service(alert_type, value, ok):
    if ok:
        assert thresholds.validate(alert_type, value) == float(value)
    else:
        with pytest.raises(HTTPException) as error:
            thresholds.validate(alert_type, value)
        assert error.value.status_code == 422


def test_update_pushes_only_its_own_key_then_stores_and_mirrors(db, ai):
    thresholds.update_threshold(db, "weapon", 0.7, require_ai=False)

    assert ai.calls == [("PATCH", "/config", {"changes": {"weapon": {"conf": 0.7}}, "persist": False})]
    assert row(db, "weapon").confidence == 0.7
    assert get_seuil_confiance_arme() == 0.7


def test_a_value_the_ai_service_refuses_is_not_stored(db, ai):
    ai.reply = (422, {"detail": {"message": "config not changed", "errors": ["weapon.conf must be in (0.0, 1.0]"]}})
    with pytest.raises(HTTPException) as error:
        thresholds.update_threshold(db, "weapon", 0.7, require_ai=False)
    assert error.value.status_code == 422
    assert row(db, "weapon") is None
    assert get_seuil_confiance_arme() == DEFAULT_WEAPON_THRESHOLD


def test_weapon_saves_while_the_ai_service_is_down_wanted_does_not(db, ai):
    ai.reply = HTTPException(503, "Service IA indisponible")

    thresholds.update_threshold(db, "weapon", 0.7, require_ai=False)
    assert row(db, "weapon").confidence == 0.7

    with pytest.raises(HTTPException) as error:
        thresholds.update_threshold(db, "wanted", 0.6, require_ai=True)
    assert error.value.status_code == 503
    assert row(db, "wanted") is None


def test_restore_pushes_the_stored_values_after_an_ai_restart(db, ai):
    db.add_all([AIAlertThreshold(alert_type="weapon", confidence=0.7),
                AIAlertThreshold(alert_type="wanted", confidence=0.6)])
    db.commit()

    assert thresholds.restore_thresholds(["weapon", "wanted"]) is True

    assert [c[2]["changes"] for c in ai.calls] == [{"weapon": {"conf": 0.7}}, {"wanted": {"threshold": 0.6}}]
    assert get_seuil_confiance_arme() == 0.7


def test_restore_leaves_wanted_to_the_ai_config_file_until_something_is_stored(db, ai):
    assert thresholds.restore_thresholds(["wanted"]) is True
    assert ai.calls == []


def test_restore_asks_for_a_retry_when_the_ai_service_is_unreachable(db, ai):
    db.add(AIAlertThreshold(alert_type="weapon", confidence=0.7))
    db.commit()
    ai.reply = HTTPException(503, "Service IA indisponible")
    assert thresholds.restore_thresholds(["weapon"]) is False


def test_restore_skips_a_value_the_ai_service_refuses_without_failing(db, ai):
    db.add(AIAlertThreshold(alert_type="wanted", confidence=0.6))
    db.commit()
    ai.reply = (422, {"detail": "no"})
    assert thresholds.restore_thresholds(["wanted"]) is True


def test_store_after_ai_accepted_keeps_a_value_the_route_already_pushed(db, ai):
    thresholds.store_after_ai_accepted(db, "wanted", 0.55)
    assert row(db, "wanted").confidence == 0.55
    assert ai.calls == []
