/**
 * Clock time rendering, in one place.
 *
 * Every timestamp in the contract is an ISO instant, and every one of them is
 * shown to someone standing in a branch who wants "08:24", not an ISO string.
 * Centralised so the six screens can't drift into six formats, and so an
 * unparseable value degrades to an em dash instead of "Invalid Date".
 *
 * Only the component is exported. A file that exports both a component and a
 * plain function loses fast refresh for that file - the same reason
 * SessionContext.ts is kept out of session.tsx.
 */
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** <time> so the machine-readable value survives even though we show "08:24". */
export function Clock({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-ink-3">—</span>

  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return <span className="text-ink-3">—</span>

  return (
    <time dateTime={date.toISOString()} className="tabular">
      {TIME_FORMAT.format(date)}
    </time>
  )
}
