import pytest
from pydantic import ValidationError

from app.schemas.camera import CameraCreate, CameraUpdate


@pytest.mark.parametrize(
    "url",
    ["rtsp://192.168.1.16:8554/stream", "RTSP://cam.local/live", "rtsps://cam/x", "http://cam/stream.mjpg",
     "https://cam.example/live", "  rtsp://cam/x  "],
)
def test_network_video_addresses_are_accepted(url):
    assert CameraCreate(name="c", stream_url=url).stream_url == url
    assert CameraUpdate(stream_url=url).stream_url == url


@pytest.mark.parametrize(
    "url",
    ["C:\videos\demo.mp4", "/etc/passwd", "file:///etc/passwd", "ftp://cam/x", "0", "rtsp://", "rtsp:///path",
     "javascript:alert(1)", "cam.local/stream"],
)
def test_anything_else_is_refused(url):
    with pytest.raises(ValidationError):
        CameraCreate(name="c", stream_url=url)
    with pytest.raises(ValidationError):
        CameraUpdate(stream_url=url)


def test_an_update_that_leaves_the_stream_alone_is_fine():
    assert CameraUpdate(name="renamed").stream_url is None
