"""Each alert consumer registers only the cameras set to run its detection."""
from app.ai_alerts.camera_features import sources_for
from app.models.entities import Camera


def test_sources_follow_each_cameras_features(db, agency):
    db.add_all([
        Camera(agency_id=agency.id, name="overhead", stream_url="rtsp://x/1", ai_features=["weapon", "fire"]),
        Camera(agency_id=agency.id, name="kiosk", stream_url="rtsp://x/2", ai_features=["wanted", "emotion"]),
        Camera(agency_id=agency.id, name="legacy", stream_url="rtsp://x/3"),  # NULL = everything
        Camera(agency_id=agency.id, name="off", stream_url="rtsp://x/4", ai_features=[]),
    ])
    db.commit()
    assert sorted(sources_for(db, "weapon")) == ["legacy", "overhead"]
    assert sorted(sources_for(db, "wanted")) == ["kiosk", "legacy"]
    assert sorted(sources_for(db, "emotion")) == ["kiosk", "legacy"]
    assert sources_for(db, "fire")["overhead"] == "rtsp://x/1"


def test_alerts_close_when_their_camera_stops_running_the_detection(db, agency, monkeypatch):
    import app.ai_alerts.camera_features as cf
    from app.models.entities import Alert, AlertSeverity, AlertStatus

    monkeypatch.setattr(cf, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    overhead = Camera(agency_id=agency.id, name="overhead", stream_url="rtsp://x/1")
    kiosk = Camera(agency_id=agency.id, name="kiosk", stream_url="rtsp://x/2")
    db.add_all([overhead, kiosk])
    db.commit()
    stale = Alert(agency_id=agency.id, camera_id=overhead.id, alert_type="wanted", title="t", message="m",
                  severity=AlertSeverity.CRITICAL, status=AlertStatus.ACKNOWLEDGED)
    live = Alert(agency_id=agency.id, camera_id=kiosk.id, alert_type="wanted", title="t", message="m",
                 severity=AlertSeverity.CRITICAL, status=AlertStatus.OPEN)
    db.add_all([stale, live])
    db.commit()

    assert cf.close_alerts_off_feature("wanted", {"kiosk"}) == 1
    assert stale.status == AlertStatus.RESOLVED and stale.resolved_at is not None
    assert live.status == AlertStatus.OPEN
