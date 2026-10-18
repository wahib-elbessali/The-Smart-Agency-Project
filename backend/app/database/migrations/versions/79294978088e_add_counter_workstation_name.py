"""add counter workstation name

Revision ID: 79294978088e
Revises: 28ba67feb54b
Create Date: 2026-10-02 00:36:11.313744

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa



revision: str = '79294978088e'
down_revision: Union[str, Sequence[str], None] = '28ba67feb54b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:

    op.add_column('counters', sa.Column('workstation_name', sa.String(length=150), nullable=True))



def downgrade() -> None:

    op.drop_column('counters', 'workstation_name')

