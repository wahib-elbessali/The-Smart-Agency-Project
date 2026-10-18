"""Brute-force protection for the login route.

Failed attempts are counted per email address and per client address inside a
sliding window. Over the limit, further attempts are refused with 429 (even a
correct password) until old failures age out, so a guessing run gets nowhere
while the real user is only locked out for minutes.

In memory on purpose: the deployed system is one process on one machine, and a
restart clearing the counters is harmless. With several worker processes each
would count separately; move this to Redis then.
"""

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, status


class LoginThrottle:
    def __init__(
        self,
        *,
        per_email: int = 5,
        per_client: int = 30,
        window_seconds: float = 600.0,
        clock=time.monotonic,
    ) -> None:
        self.per_email = per_email
        self.per_client = per_client
        self.window = window_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._by_email: dict[str, deque[float]] = defaultdict(deque)
        self._by_client: dict[str, deque[float]] = defaultdict(deque)

    def _trim(self, attempts: deque[float], now: float) -> None:
        while attempts and now - attempts[0] >= self.window:
            attempts.popleft()

    def check(self, email: str, client: str) -> None:
        """Raise 429 if either counter is already at its limit."""
        now = self._clock()
        with self._lock:
            for store, key, limit in (
                (self._by_email, email, self.per_email),
                (self._by_client, client, self.per_client),
            ):
                attempts = store[key]
                self._trim(attempts, now)
                if len(attempts) >= limit:
                    retry = int(self.window - (now - attempts[0])) + 1
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail="Trop de tentatives de connexion. Reessayez plus tard",
                        headers={"Retry-After": str(max(retry, 1))},
                    )

    def failed(self, email: str, client: str) -> None:
        now = self._clock()
        with self._lock:
            self._by_email[email].append(now)
            self._by_client[client].append(now)

    def succeeded(self, email: str) -> None:
        """A correct login clears that account's failures (not the client's)."""
        with self._lock:
            self._by_email.pop(email, None)

    def reset(self) -> None:
        with self._lock:
            self._by_email.clear()
            self._by_client.clear()


login_throttle = LoginThrottle()
