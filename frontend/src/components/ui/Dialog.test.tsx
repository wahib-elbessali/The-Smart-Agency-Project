import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Dialog } from './Dialog'

/* A form whose state is seeded once from props - the shape every edit form
   in the app has (useState(() => initialValues(record))). */
function NameForm({ initial }: { initial: string }) {
  const [name, setName] = useState(initial)
  return <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
}

function Harness() {
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <>
      <button onClick={() => setEditing('Alice')}>Edit Alice</button>
      <button onClick={() => setEditing('')}>Add</button>
      <button onClick={() => setEditing(null)}>Close</button>
      <Dialog open={editing !== null} title="Person" onClose={() => setEditing(null)}>
        {editing !== null && <NameForm initial={editing} />}
      </Dialog>
    </>
  )
}

describe('Dialog', () => {
  /* The bug the day test found: the dialog keeps its last children mounted
     for the exit animation, so a form reopened for another record reused
     the old instance and showed the previous record (Add showed the last
     employee, Edit showed a blank form). */
  it('mounts fresh content every time it opens', () => {
    render(<Harness />)

    fireEvent.click(screen.getByText('Edit Alice'))
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Alice')
    fireEvent.click(screen.getByText('Close'))

    fireEvent.click(screen.getByText('Add'))
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'typed' } })
    fireEvent.click(screen.getByText('Close'))

    fireEvent.click(screen.getByText('Edit Alice'))
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Alice')
  })
})
