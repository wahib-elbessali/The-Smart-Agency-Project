import app.services.people_tracking as pt
from app.services.people_tracking import point_in_polygon

SQUARE = [[1, 4], [4, 4], [4, 7], [1, 7]]  # metres, as GET /zoning/zones exports it


def tracker_with(**tracks):
    pt.people_track_tracker.process_message(
        {"type": "tracks", "tracks": [{"id": k, "x": v[0], "y": v[1]} for k, v in tracks.items()]}
    )


def test_point_in_polygon_basics():
    square = [[0, 0], [10, 0], [10, 10], [0, 10]]
    assert point_in_polygon(5, 5, square)
    assert not point_in_polygon(15, 5, square)
    assert not point_in_polygon(5, 5, [[0, 0], [1, 1]])  # not a polygon


def test_track_in_centimetres_matches_zone_in_metres():
    tracker_with(a=(210.5, 533.0))
    match = pt._track_in_zone({"polygon_m": SQUARE})
    assert match is not None and match[0] == "a"


def test_track_outside_zone_does_not_match():
    tracker_with(a=(900.0, 900.0))
    assert pt._track_in_zone({"polygon_m": SQUARE}) is None


def test_pixel_zone_without_polygon_m_never_matches():
    tracker_with(a=(210.5, 533.0))
    assert pt._track_in_zone({"mode": "pixel", "polygon_px": SQUARE}) is None


def test_malformed_polygon_does_not_raise():
    tracker_with(a=(210.5, 533.0))
    assert pt._track_in_zone({"polygon_m": [["x", "y"], [1, 2], [3, 4]]}) is None


def test_first_seen_is_carried_across_snapshots():
    tracker_with(a=(1.0, 1.0))
    first = pt.people_track_tracker.tracks_snapshot()["a"]["first_seen"]
    tracker_with(a=(2.0, 2.0), b=(3.0, 3.0))
    snapshot = pt.people_track_tracker.tracks_snapshot()
    assert snapshot["a"]["first_seen"] == first
    assert set(snapshot) == {"a", "b"}
    tracker_with(b=(3.0, 3.0))
    assert set(pt.people_track_tracker.tracks_snapshot()) == {"b"}
