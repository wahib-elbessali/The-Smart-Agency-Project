import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { fetchBranchComparison } from '@/api/endpoints/insights'
import { useScope } from '@/agency/ScopeContext'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { Badge } from '@/components/ui/Badge'
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel'
import { COLUMNS, DEFAULT_SORT, nextSort, sortBranches, type Sort } from './branchTable'

/**
 * Every branch side by side (scenario-planning backlog, "Multi-branch
 * comparison"). A live snapshot, refreshed on the same ten-second cadence as
 * the per-branch overview, using exactly the metrics that overview already has.
 *
 * Neutral by design: nothing is coloured, ranked or flagged. Which number is
 * worrying depends on the branch, and the admin is the one who knows - the
 * table only lets them sort by whatever they want to compare.
 */
export function BranchComparison() {
  const scope = useScope()
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT)

  const comparison = useQuery({
    queryKey: ['insights-branches'],
    queryFn: ({ signal }) => fetchBranchComparison(signal),
    refetchInterval: 10_000,
  })

  const rows = useMemo(() => sortBranches(comparison.data ?? [], sort), [comparison.data, sort])

  return (
    <Panel as="section">
      <PanelHeader>
        <h2 className="text-ink text-sm font-semibold">All branches</h2>
        <p className="text-ink-3 mt-1 text-xs leading-relaxed">
          Live, refreshed every ten seconds. Click a column to sort; a dash means no data yet, not
          zero. Open a branch for its full detail.
        </p>
      </PanelHeader>
      <PanelBody className="overflow-x-auto p-0">
        <AsyncBoundary
          isPending={comparison.isPending}
          error={comparison.error}
          isEmpty={comparison.data?.length === 0}
          emptyMessage="No branches yet, so there is nothing to compare."
          forbiddenMessage="The branch comparison is for administrators."
          onRetry={() => void comparison.refetch()}
          skeletonRows={4}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-ink-3 border-line border-b text-left text-xs">
                {COLUMNS.map((column) => {
                  const active = sort.key === column.key
                  const Icon = !active
                    ? ArrowUpDown
                    : sort.direction === 'asc'
                      ? ArrowUp
                      : ArrowDown
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={
                        active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                      className="px-3 py-2 font-medium whitespace-nowrap"
                    >
                      <button
                        type="button"
                        title={column.hint}
                        onClick={() => setSort(nextSort(sort, column.key))}
                        className={`inline-flex items-center gap-1 ${active ? 'text-ink' : ''}`}
                      >
                        {column.label}
                        <Icon className="size-3" aria-hidden />
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((branch) => (
                <tr key={branch.agency_id} className="border-line/60 border-b last:border-0">
                  {COLUMNS.map((column) => {
                    const text = column.format(column.value(branch))
                    if (column.key === 'name') {
                      return (
                        <th
                          key={column.key}
                          scope="row"
                          className="px-3 py-2 text-left whitespace-nowrap"
                        >
                          <button
                            type="button"
                            title={`Open ${branch.name}`}
                            onClick={() => scope.enter({ id: branch.agency_id, name: branch.name })}
                            className="text-ink hover:text-accent font-medium underline-offset-2 hover:underline"
                          >
                            {text}
                          </button>
                          {!branch.is_active && (
                            <Badge tone="neutral" className="ml-2">
                              Inactive
                            </Badge>
                          )}
                        </th>
                      )
                    }
                    return (
                      <td
                        key={column.key}
                        className="text-ink-2 tabular px-3 py-2 whitespace-nowrap"
                      >
                        {text}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </PanelBody>
    </Panel>
  )
}
