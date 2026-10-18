from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.api.reports import MAX_REPORT_DAYS, _window

TODAY = datetime.now(timezone.utc).date()


def test_valid_window_counts_days_inclusively():
    period, since, until = _window(TODAY - timedelta(days=2), TODAY)
    assert period.days == 3
    assert until - since == timedelta(days=3)


@pytest.mark.parametrize(
    "start,end",
    [
        (TODAY, TODAY - timedelta(days=1)),
        (TODAY, TODAY + timedelta(days=1)),
        (TODAY - timedelta(days=MAX_REPORT_DAYS), TODAY),
    ],
)
def test_bad_windows_are_422(start, end):
    with pytest.raises(HTTPException) as err:
        _window(start, end)
    assert err.value.status_code == 422
