import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Panel, PanelBody } from '@/components/ui/Panel'

/**
 * Catches a render error in one screen so it does not take the whole app
 * with it. Without this, any throw while rendering - one malformed field in a
 * live stream frame was enough - unmounted the entire tree and left a white
 * page until a manual reload. The shell (navigation, header) sits outside, so
 * the person can still move to another screen; AppShell keys this by path, so
 * navigating away also clears the error.
 */
export class ScreenErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed', error, info.componentStack)
  }

  render() {
    if (this.state.error === null) return this.props.children
    return (
      <Panel as="section" tone="alert">
        <PanelBody className="flex gap-3">
          <AlertTriangle className="text-ink-3 mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <h2 className="text-ink text-sm font-semibold">This screen hit an error</h2>
            <p className="text-ink-2 mt-1 text-sm leading-relaxed">
              The rest of the app still works. Try again, or open another screen.
            </p>
            <p className="text-ink-3 mt-2 font-mono text-xs break-all">
              {this.state.error.message}
            </p>
            <Button size="sm" className="mt-3" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          </div>
        </PanelBody>
      </Panel>
    )
  }
}
