"""add kiosk zone tracking link

Revision ID: 2d44705abdec
Revises: b06980395ae7
Create Date: 2026-10-01 04:08:01.528169

Scenario-planning backlog (docs/scenario-planning-backlog.md), Phase B:
agencies.kiosk_zone_name names which existing AI-service zone acts as the
kiosk zone; tickets.tracking_id/tracking_first_seen_at get set by a
background task when someone's standing in it at ticket-creation time.

The ix_users_counter_id partial-unique-index diff autogenerate offers here
is the same spurious one seen in b06980395ae7 - that index's
uniqueness/WHERE clause was only ever declared in migration 5b14b5b07703's
raw SQL, never mirrored onto the User.counter_id column in entities.py, so
autogenerate keeps diffing against "no constraint declared." Excluded again.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '2d44705abdec'
down_revision: Union[str, Sequence[str], None] = 'b06980395ae7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('agencies', sa.Column('kiosk_zone_name', sa.String(length=150), nullable=True))
    op.add_column('tickets', sa.Column('tracking_id', sa.String(length=50), nullable=True))
    op.add_column('tickets', sa.Column('tracking_first_seen_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('tickets', 'tracking_first_seen_at')
    op.drop_column('tickets', 'tracking_id')
    op.drop_column('agencies', 'kiosk_zone_name')
