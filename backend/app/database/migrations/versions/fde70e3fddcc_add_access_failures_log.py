"""add access failures log

Revision ID: fde70e3fddcc
Revises: 1ece403735f1
Create Date: 2026-10-02 01:43:34.729245

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



revision: str = 'fde70e3fddcc'
down_revision: Union[str, Sequence[str], None] = '1ece403735f1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:

    op.create_table('access_failures',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('agency_id', sa.String(length=36), nullable=False),
    sa.Column('device_id', sa.String(length=36), nullable=False),
    sa.Column('scanned_uid', sa.String(length=100), nullable=False),
    sa.Column('employee_id', sa.String(length=36), nullable=True),
    sa.Column('zone_id', sa.String(length=36), nullable=True),
    sa.Column('source', sa.String(length=20), nullable=False),
    sa.Column('reason', sa.String(length=30), nullable=False),
    sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['agency_id'], ['agencies.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['zone_id'], ['zones.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_access_failures_agency_id'), 'access_failures', ['agency_id'], unique=False)
    op.create_index(op.f('ix_access_failures_device_id'), 'access_failures', ['device_id'], unique=False)
    op.create_index(op.f('ix_access_failures_occurred_at'), 'access_failures', ['occurred_at'], unique=False)
    op.add_column('agencies', sa.Column('access_failure_threshold', sa.Integer(), server_default='5', nullable=True))
    op.add_column('agencies', sa.Column('access_failure_window_minutes', sa.Integer(), server_default='10', nullable=False))



def downgrade() -> None:

    op.drop_column('agencies', 'access_failure_window_minutes')
    op.drop_column('agencies', 'access_failure_threshold')
    op.drop_index(op.f('ix_access_failures_occurred_at'), table_name='access_failures')
    op.drop_index(op.f('ix_access_failures_device_id'), table_name='access_failures')
    op.drop_index(op.f('ix_access_failures_agency_id'), table_name='access_failures')
    op.drop_table('access_failures')

