import { useId, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { CornerDownLeft, Search, type LucideIcon } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { cn } from '@/components/ui/cn'
import { controlClass } from '@/components/ui/control'

export interface PaletteEntry {
  to: string
  label: string
  description: string
  icon: LucideIcon
  section: string
}

/**
 * Ctrl+K / Cmd+K: type part of a screen's name, press Enter, you are there.
 *
 * The sidebar already shows every screen, so this is a shortcut, not a second
 * way of finding things - it never lists anything the sidebar does not, and
 * the caller hands it the same role-filtered list for that reason.
 *
 * Built on the shared Dialog for focus trapping and Escape. The list is a
 * listbox driven from the input (aria-activedescendant), so focus stays in the
 * text field while the arrow keys move the highlight - the pattern screen
 * readers expect from a combobox.
 *
 * The body is its own component, mounted only while open, so the query and
 * highlight reset each time it opens without an effect to clear them.
 */
export function CommandPalette({
  open,
  onClose,
  entries,
}: {
  open: boolean
  onClose: () => void
  entries: readonly PaletteEntry[]
}) {
  return (
    <Dialog open={open} title="Go to a screen" onClose={onClose}>
      {open && <PaletteBody entries={entries} onClose={onClose} />}
    </Dialog>
  )
}

function PaletteBody({
  entries,
  onClose,
}: {
  entries: readonly PaletteEntry[]
  onClose: () => void
}) {
  const navigate = useNavigate()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const needle = query.trim().toLowerCase()
  /* Name matches first, then description matches - typing "door" should
     still find Manual controls, but never above a screen called that. */
  const results = needle
    ? [
        ...entries.filter(({ label }) => label.toLowerCase().includes(needle)),
        ...entries.filter(
          ({ label, description }) =>
            !label.toLowerCase().includes(needle) && description.toLowerCase().includes(needle),
        ),
      ]
    : entries
  const highlighted = Math.min(active, Math.max(results.length - 1, 0))

  const go = (to: string) => {
    onClose()
    void navigate(to)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((highlighted + 1) % Math.max(results.length, 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((highlighted - 1 + results.length) % Math.max(results.length, 1))
    } else if (event.key === 'Enter' && results[highlighted]) {
      event.preventDefault()
      go(results[highlighted].to)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search
          className="text-ink-3 pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-label="Screen name"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={results[highlighted] ? `${listId}-${highlighted}` : undefined}
          placeholder="Type a screen name…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          className={cn(controlClass(), 'pl-9')}
        />
      </div>

      {results.length === 0 ? (
        <p className="text-ink-3 px-1 py-6 text-center text-sm">No screen matches “{query}”.</p>
      ) : (
        <ul
          id={listId}
          role="listbox"
          aria-label="Screens"
          className="-mx-1 max-h-80 overflow-y-auto"
        >
          {results.map(({ to, label, description, icon: Icon, section }, index) => (
            <li
              key={to}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              onMouseMove={() => setActive(index)}
              onClick={() => go(to)}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2',
                index === highlighted ? 'bg-panel-2 text-ink' : 'text-ink-2',
              )}
            >
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center',
                  index === highlighted ? 'text-ink' : 'text-ink-3',
                )}
              >
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-ink block text-sm">{label}</span>
                <span className="text-ink-3 block truncate text-xs">{description}</span>
              </span>
              <span className="text-ink-3 tracked shrink-0 text-[10px]">{section}</span>
              {index === highlighted && (
                <CornerDownLeft className="text-ink-3 size-3.5 shrink-0" aria-hidden />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
