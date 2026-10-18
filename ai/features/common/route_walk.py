"""Recursively enumerates every REAL route (APIRoute / APIWebSocketRoute) on
a FastAPI app, in a way that survives FastAPI's own included-router
representation changing across versions.

Older FastAPI/Starlette flattened every include_router() call directly into
app.routes as APIRoute/APIWebSocketRoute objects, each with its own `.path`.
Newer FastAPI (found here at 0.141.1, via requirements.txt's floor-only
`fastapi>=0.110`) wraps each included router in an internal
`_IncludedRouter` for routing performance -- that wrapper has NO `.path` of
its own; the real routes live on its `.original_router.routes`. A route
enumeration written against the old shape doesn't error at import time, it
raises AttributeError the first time something calls GET / -- caught here by
actually running the service in a clean venv with a fresh
`pip install -r requirements.txt`, not by reading the code or by testing in
this dev machine's environment (which happened to have an older FastAPI
already installed).

Used by GET / (features/main.py) and features/cloud/parity_test.py's route
parity check -- both want the same "every real endpoint, doc routes
excluded" list, so it lives here once rather than as two copies that could
individually miss the next internal reshuffle.
"""


def iter_routes(app):
    """-> [(path, sorted methods list), ...] for every real endpoint,
    excluding FastAPI's own /openapi, /docs, /redoc routes. Recurses into
    whatever shape `app.routes` uses to represent an included router."""
    out = []
    _walk(app.routes, out)
    return sorted(out)


def _walk(routes, out):
    for r in routes:
        path = getattr(r, "path", None)
        if path is not None:
            if path.startswith(("/openapi", "/docs", "/redoc")):
                continue
            out.append((path, sorted(getattr(r, "methods", None) or ["WEBSOCKET"])))
            continue
        # Not a real route -- an included-router wrapper (or a Mount) whose
        # actual routes live one level deeper. Try both known shapes rather
        # than hardcoding one, so this doesn't silently break again the next
        # time either library reshapes this internal: newer FastAPI's
        # `_IncludedRouter` keeps them on `.original_router.routes`; a plain
        # Starlette `Mount` (not used today, but a reasonable future case)
        # keeps them on `.routes` directly.
        nested = getattr(r, "routes", None) or getattr(getattr(r, "original_router", None), "routes", None)
        if nested:
            _walk(nested, out)
