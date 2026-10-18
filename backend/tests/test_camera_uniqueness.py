from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.api.cameras import camera_integrity_error_detail, ensure_unique_stream_url


class FakeDatabase:
    def __init__(self, result: object | None) -> None:
        self.result = result

    def scalar(self, _query: object) -> object | None:
        return self.result


def test_duplicate_stream_url_returns_conflict() -> None:
    with pytest.raises(HTTPException) as error:
        ensure_unique_stream_url(
            "rtsp://192.168.1.16:8554/stream",
            FakeDatabase(SimpleNamespace(id="other-camera")),
        )

    assert error.value.status_code == 409
    assert error.value.detail == (
        "Le flux de la camera est deja utilise par une autre camera"
    )


def test_unused_stream_url_is_accepted() -> None:
    ensure_unique_stream_url(
        "rtsp://192.168.1.17:8554/stream",
        FakeDatabase(None),
    )


def test_database_stream_url_constraint_has_a_clear_conflict_message() -> None:
    original = SimpleNamespace(
        diag=SimpleNamespace(constraint_name="uq_camera_stream_url")
    )
    error = IntegrityError("insert", {}, original)

    assert camera_integrity_error_detail(error) == (
        "Le flux de la camera est deja utilise par une autre camera"
    )
