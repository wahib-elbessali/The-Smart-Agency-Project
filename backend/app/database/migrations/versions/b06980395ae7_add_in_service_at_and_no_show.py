"""add in_service_at timestamp, per-agency no-show wait, NO_SHOW status

Revision ID: b06980395ae7
Revises: 5b14b5b07703
Create Date: 2026-10-01 03:37:32.382783

The manual "start service" action needs its own timestamp to split queue-wait
from actual service time, and the manual no-show skip needs a per-agency
minimum wait plus its own status value.

The ix_users_counter_id partial-unique-index diff autogenerate also wanted
to make here is spurious - that index's uniqueness/WHERE clause was only
ever declared in migration 5b14b5b07703's raw SQL, never mirrored onto the
User.counter_id column in entities.py, so autogenerate diffs against "no
constraint declared" and offers to drop the uniqueness. Deliberately
excluded from both directions below.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b06980395ae7'
down_revision: Union[str, Sequence[str], None] = '5b14b5b07703'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('agencies', sa.Column('no_show_min_wait_seconds', sa.Integer(), server_default='60', nullable=False))
    op.add_column('tickets', sa.Column('in_service_at', sa.DateTime(timezone=True), nullable=True))
    # Postgres requires an enum ADD VALUE to run outside the migration's own
    # transaction - autocommit_block commits what's open so far, runs this
    # statement on its own, then opens a fresh transaction for anything
    # after it in this migration (there's nothing after it here).
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE ticketstatus ADD VALUE IF NOT EXISTS 'NO_SHOW'")


def downgrade() -> None:
    # Postgres cannot drop a single enum value, so NO_SHOW is left in the
    # type on downgrade - only the two plain columns are reverted.
    op.drop_column('tickets', 'in_service_at')
    op.drop_column('agencies', 'no_show_min_wait_seconds')
