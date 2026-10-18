"""make camera stream URLs unique

Revision ID: a1d3f5b7c9e2
Revises: fde70e3fddcc
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1d3f5b7c9e2"
down_revision: Union[str, Sequence[str], None] = "fde70e3fddcc"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    duplicates = op.get_bind().execute(
        sa.text(
            """
            SELECT stream_url FROM cameras
            WHERE stream_url IS NOT NULL
            GROUP BY stream_url HAVING COUNT(*) > 1
            ORDER BY stream_url
            """
        )
    ).all()
    if duplicates:
        raise RuntimeError(
            "Migration aborted: duplicate camera stream_url values exist. "
            "Resolve these values before retrying: " + ", ".join(str(r[0]) for r in duplicates)
        )
    op.create_unique_constraint("uq_camera_stream_url", "cameras", ["stream_url"])


def downgrade() -> None:
    op.drop_constraint("uq_camera_stream_url", "cameras", type_="unique")
