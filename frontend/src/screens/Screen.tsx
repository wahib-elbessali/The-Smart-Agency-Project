import type { ReactNode } from 'react'

/**
 * Shared page frame, so every screen gets the same heading rhythm.
 *
 * The page name is 20px semibold (2026-10-10; it was 16px bold). Still far
 * from a display heading - a dashboard is read for its numbers - but at 16px
 * it sat at the same weight as the card titles beneath it and the page had no
 * clear top. One clear step up is enough to anchor the screen.
 *
 * There used to be a breadcrumb above it, repeating the page name as the last
 * crumb. Removed on request: the navigation is one level deep and permanently
 * on screen, so a trail from Home to the item highlighted in the sidebar told
 * nobody anything they could not already see, and it cost a row at the top of
 * every page.
 */
export function Screen({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      {/* Baseline-aligned, not top-aligned: the action sitting on the same
          line as the title is what makes a header read as one row rather than
          two things that happen to be near each other. */}
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-ink text-xl leading-tight font-semibold">{title}</h1>

          {description && <p className="text-ink-2 mt-2 text-sm">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}
