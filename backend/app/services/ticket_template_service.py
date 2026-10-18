import base64
import binascii
import io
import re
from typing import Any

from fastapi import HTTPException
from PIL import Image


DEFAULT_TICKET_TEMPLATE: list[dict[str, Any]] = [
    {"type": "text", "content": "Bienvenue chez nous"},
    {"type": "agency_name"},
    {"type": "ticket_number"},
    {"type": "service_name"},
    {"type": "date"},
]

TEMPLATE_TYPES = {
    "text",
    "agency_name",
    "ticket_number",
    "service_name",
    "date",
    "qrcode",
    "image",
    "spacing",
}
DATA_URI_RE = re.compile(r"^data:image/[a-zA-Z0-9.+-]+;base64,(?P<data>.+)$", re.DOTALL)
MAX_IMAGE_WIDTH = 384
MAX_IMAGE_ROWS = 1024
MAX_IMAGE_DATA_CHARS = 2_800_000  # about 2 MB of image once decoded


def default_ticket_template() -> list[dict[str, Any]]:
    return [block.copy() for block in DEFAULT_TICKET_TEMPLATE]


def _invalid(index: int, message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=f"Bloc template {index}: {message}")


def _required_string(block: dict[str, Any], field: str, index: int) -> str:
    value = block.get(field)
    if not isinstance(value, str) or not value.strip():
        raise _invalid(index, f"{field} est obligatoire")
    return value


def _image_block(content: str, index: int) -> dict[str, Any]:
    match = DATA_URI_RE.match(content.strip())
    if match is None:
        raise _invalid(index, "image.content doit etre une data URI base64")

    if len(content) > MAX_IMAGE_DATA_CHARS:
        raise _invalid(index, "image trop volumineuse (maximum 2 Mo)")

    try:
        raw_image = base64.b64decode(match.group("data"), validate=True)
        with Image.open(io.BytesIO(raw_image)) as source:
            source.load()
            width, height = source.size
            if width <= 0 or height <= 0:
                raise _invalid(index, "image invalide")
            new_height = max(1, round(height * MAX_IMAGE_WIDTH / width))
            if new_height > MAX_IMAGE_ROWS:
                raise _invalid(index, f"image trop haute (maximum {MAX_IMAGE_ROWS} lignes)")
            image = source.convert("L").resize(
                (MAX_IMAGE_WIDTH, new_height),
                Image.Resampling.LANCZOS,
            ).convert("1", dither=Image.Dither.FLOYDSTEINBERG)
    except Image.DecompressionBombError as exc:
        raise _invalid(index, "image trop grande en pixels") from exc
    except (binascii.Error, OSError, ValueError) as exc:
        raise _invalid(index, "image base64 ou format image invalide") from exc

    row_bytes = (MAX_IMAGE_WIDTH + 7) // 8
    packed = bytearray(row_bytes * new_height)
    for y in range(new_height):
        for x in range(MAX_IMAGE_WIDTH):
            if image.getpixel((x, y)) == 0:
                packed[y * row_bytes + x // 8] |= 1 << (7 - x % 8)

    return {
        "type": "image",
        "data": base64.b64encode(packed).decode("ascii"),
        "rows": new_height,
    }


def _processed_image_block(block: dict[str, Any], index: int) -> dict[str, Any]:
    """An image block exactly as GET returns it (packed bitmap + rows), sent
    back unchanged. Without this, loading a saved template into an editor and
    saving it again failed on any existing image, because the stored form has
    no `content` to re-process. Validated, not trusted: the bitmap must be
    valid base64 of exactly 48 bytes per row, within the same row limit."""
    rows = block.get("rows")
    data = block.get("data")
    if isinstance(rows, bool) or not isinstance(rows, int) or not 1 <= rows <= MAX_IMAGE_ROWS:
        raise _invalid(index, f"image.rows doit etre un entier entre 1 et {MAX_IMAGE_ROWS}")
    if not isinstance(data, str):
        raise _invalid(index, "image.data est obligatoire")
    try:
        packed = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _invalid(index, "image.data n'est pas du base64 valide") from exc
    if len(packed) != ((MAX_IMAGE_WIDTH + 7) // 8) * rows:
        raise _invalid(index, "image.data ne correspond pas a image.rows")
    return {"type": "image", "data": data, "rows": rows}


def process_ticket_template(raw_template: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not raw_template:
        raise HTTPException(status_code=422, detail="Le template ne peut pas etre vide")

    processed: list[dict[str, Any]] = []
    for index, block in enumerate(raw_template):
        if not isinstance(block, dict):
            raise _invalid(index, "doit etre un objet JSON")
        block_type = block.get("type")
        if block_type not in TEMPLATE_TYPES:
            raise _invalid(index, "type inconnu")

        if block_type == "text":
            processed.append({"type": "text", "content": _required_string(block, "content", index)})
        elif block_type in {"agency_name", "ticket_number", "service_name", "date"}:
            processed.append({"type": block_type})
        elif block_type == "qrcode":
            processed.append({"type": "qrcode", "content": _required_string(block, "content", index)})
        elif block_type == "image":
            if "content" not in block and "data" in block:
                processed.append(_processed_image_block(block, index))
            else:
                processed.append(_image_block(_required_string(block, "content", index), index))
        else:
            lines = block.get("lines")
            if isinstance(lines, bool) or not isinstance(lines, int) or lines < 0:
                raise _invalid(index, "lines doit etre un entier positif ou nul")
            processed.append({"type": "spacing", "lines": lines})

    return processed


def stored_or_default_ticket_template(stored: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return stored if stored else default_ticket_template()
