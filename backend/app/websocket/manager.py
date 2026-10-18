import asyncio
from typing import Any

from fastapi import WebSocket


# A connection's scope is either one agency id or this marker (an admin).
ALL_AGENCIES = "*"


class AttendanceConnectionManager:
    def __init__(self) -> None:
        # websocket -> the one agency it may see, or ALL_AGENCIES
        self.connections: dict[WebSocket, str] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, websocket: WebSocket, scope: str = ALL_AGENCIES) -> None:
        await websocket.accept()
        self.connections[websocket] = scope
        self.loop = asyncio.get_running_loop()

    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.pop(websocket, None)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        disconnected: list[WebSocket] = []
        for websocket, scope in list(self.connections.items()):
            # Every event names its agency; a connection sees only its own.
            if scope != ALL_AGENCIES and payload.get("agency_id") != scope:
                continue
            try:
                await websocket.send_json(payload)
            except Exception:
                disconnected.append(websocket)
        for websocket in disconnected:
            self.disconnect(websocket)

    def broadcast_from_thread(self, payload: dict[str, Any]) -> None:
        if self.loop is not None and not self.loop.is_closed():
            asyncio.run_coroutine_threadsafe(self.broadcast(payload), self.loop)


attendance_manager = AttendanceConnectionManager()
