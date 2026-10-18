"""enforce one active agent per counter

UX_AUDIT.md finding 3: nothing in the schema stopped two agents from
independently setting the same counter_id - the application-level fix in
app/api/assignments.py (clearing the previous agent on reassignment) closes
the normal path, but only a constraint closes every path (a second server
process, a hand-run script, a future endpoint that forgets the check).

Partial index, not a plain unique constraint: many agents are unassigned at
once (counter_id IS NULL), which a plain UNIQUE would treat as one column
value clashing with itself. Only non-null counter_id needs to be unique.

Revision ID: 5b14b5b07703
Revises: e9cc301aad78
"""

from typing import Sequence, Union

from alembic import op


revision: str = "5b14b5b07703"
down_revision: Union[str, Sequence[str], None] = "e9cc301aad78"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index("ix_users_counter_id", table_name="users")
    op.create_index(
        "ix_users_counter_id",
        "users",
        ["counter_id"],
        unique=True,
        postgresql_where="counter_id IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_index("ix_users_counter_id", table_name="users")
    op.create_index("ix_users_counter_id", "users", ["counter_id"])
