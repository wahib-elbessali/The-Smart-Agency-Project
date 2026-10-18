from datetime import datetime, timedelta

from app.models.entities import Device, DeviceStatus, DeviceStatusSample
from app.services.device_uptime import is_online, record_device_samples

# Naive: SQLite drops tzinfo on read where Postgres returns aware datetimes.
NOW = datetime(2026, 10, 2, 12, 0)


def device(db, agency, name, heartbeat, seen_ago, status=DeviceStatus.ONLINE):
    row = Device(
        agency_id=agency.id,
        name=name,
        device_type="SENSOR",
        mqtt_client_id=name,
        mqtt_topic="x",
        heartbeat_seconds=heartbeat,
        last_seen_at=None if seen_ago is None else NOW - timedelta(seconds=seen_ago),
        status=status,
    )
    db.add(row)
    db.commit()
    return row


def test_online_within_three_missed_heartbeats(db, agency):
    assert is_online(device(db, agency, "a", 60, 150), NOW)
    assert not is_online(device(db, agency, "b", 60, 200), NOW)


def test_never_seen_or_untracked_is_not_online(db, agency):
    assert not is_online(device(db, agency, "c", 60, None), NOW)
    assert not is_online(device(db, agency, "d", None, 5), NOW)


def test_sampler_corrects_status_and_skips_untracked_and_explicit_states(db, agency):
    dead = device(db, agency, "dead", 60, 1000, status=DeviceStatus.ONLINE)
    alive = device(db, agency, "alive", 60, 10, status=DeviceStatus.OFFLINE)
    quiet = device(db, agency, "quiet-reader", None, 100000, status=DeviceStatus.ONLINE)
    broken = device(db, agency, "broken", 60, 1000, status=DeviceStatus.ERROR)

    assert record_device_samples(db, NOW) == 3  # the untracked reader is left alone
    for row in (dead, alive, quiet, broken):
        db.refresh(row)
    assert dead.status == DeviceStatus.OFFLINE
    assert alive.status == DeviceStatus.ONLINE
    assert quiet.status == DeviceStatus.ONLINE
    assert broken.status == DeviceStatus.ERROR
    assert db.query(DeviceStatusSample).count() == 3


def test_old_samples_are_pruned(db, agency):
    row = device(db, agency, "p", 60, 10)
    db.add(DeviceStatusSample(device_id=row.id, sampled_at=NOW - timedelta(days=400), online=True))
    db.commit()
    record_device_samples(db, NOW)
    old = db.query(DeviceStatusSample).filter(DeviceStatusSample.sampled_at < NOW - timedelta(days=300))
    assert old.count() == 0
