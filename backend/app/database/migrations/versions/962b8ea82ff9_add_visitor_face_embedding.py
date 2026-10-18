"""add visitor face embedding

Revision ID: 962b8ea82ff9
Revises: 93703d1c9718
Create Date: 2026-10-01 13:32:17.731800

visitors.face_embedding, a 512-float vector captured via /face/capture at
kiosk ticket time, used to recognize a returning visitor by face alone -
never exposed in VisitorResponse.

The ix_users_counter_id partial-unique-index diff autogenerate offers here
is the same spurious one seen in every prior migration this backlog added -
excluded again, same reason (never mirrored onto the User.counter_id column
in entities.py).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '962b8ea82ff9'
down_revision: Union[str, Sequence[str], None] = '93703d1c9718'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('visitors', sa.Column('face_embedding', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('visitors', 'face_embedding')
