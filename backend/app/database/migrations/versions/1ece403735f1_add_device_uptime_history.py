"""add device uptime history

Revision ID: 1ece403735f1
Revises: 22424b721b3f
Create Date: 2026-10-02 01:33:45.258641

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



revision: str = '1ece403735f1'
down_revision: Union[str, Sequence[str], None] = '22424b721b3f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:

    op.create_table('device_status_samples',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('device_id', sa.String(length=36), nullable=False),
    sa.Column('sampled_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('online', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_device_status_samples_device_id'), 'device_status_samples', ['device_id'], unique=False)
    op.create_index(op.f('ix_device_status_samples_sampled_at'), 'device_status_samples', ['sampled_at'], unique=False)
    op.add_column('devices', sa.Column('heartbeat_seconds', sa.Integer(), nullable=True))



def downgrade() -> None:

    op.drop_column('devices', 'heartbeat_seconds')
    op.drop_index(op.f('ix_device_status_samples_sampled_at'), table_name='device_status_samples')
    op.drop_index(op.f('ix_device_status_samples_device_id'), table_name='device_status_samples')
    op.drop_table('device_status_samples')

