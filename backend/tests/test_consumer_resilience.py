"""A database error while an AI consumer reads its cameras must not stop it
for good: before this, a moment without the database silently switched off
weapon/fire/watchlist detection until the backend was restarted."""
import asyncio

import pytest

from app.ai_alerts.consumer import weapon_alert_consumer
from app.ai_alerts.emotion_consumer import emotion_consumer
from app.ai_alerts.fire_consumer import fire_alert_consumer


@pytest.mark.parametrize("consumer", [weapon_alert_consumer, fire_alert_consumer, emotion_consumer],
                         ids=["weapon", "fire", "emotion"])
def test_a_database_error_is_retried_not_fatal(consumer, monkeypatch):
    calls = []

    def load():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("database is gone")
        consumer._stop_event.set()  # second read worked: the loop is still alive
        return {}

    async def no_wait(seconds):
        return None

    monkeypatch.setattr(consumer, "_load_sources", load)
    monkeypatch.setattr(consumer, "_wait", no_wait)
    consumer._stop_event.clear()
    try:
        asyncio.run(consumer._consume_forever())
    finally:
        consumer._stop_event.clear()
    assert len(calls) == 2
