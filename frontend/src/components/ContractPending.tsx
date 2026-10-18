import { FileWarning } from 'lucide-react'
import { Panel, PanelBody } from '@/components/ui/Panel'

/**
 * Shown by a screen with no endpoint to call yet.
 *
 * Deliberately not a mock of the finished screen. A convincing fake invites
 * people to assume the data is real, and the point of this panel is that it
 * isn't - there is no contract entry behind it.
 */
export function ContractPending({ screen, note }: { screen: string; note?: string }) {
  return (
    <Panel className="max-w-2xl">
      <PanelBody className="flex gap-4 py-6">
        <FileWarning className="text-ink-3 mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <h2 className="text-ink text-sm font-semibold">Waiting on the API contract</h2>
          <p className="text-ink-2 mt-2 text-sm leading-relaxed">
            {screen} has no endpoint in <code className="text-ink-2/90">contracts/api.md</code> yet,
            so there is nothing to render. Routing, the mock layer, and the loading/empty/error
            states are already in place — this screen fills in once the contract entry is merged.
          </p>
          {note && <p className="text-ink-3 mt-3 text-sm leading-relaxed">{note}</p>}
        </div>
      </PanelBody>
    </Panel>
  )
}
