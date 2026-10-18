import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/theme/ThemeContext'
import { cn } from '@/components/ui/cn'

/**
 * Sliding two-state switch between light and dark.
 *
 * SYSTEM IS STILL IN THE MODEL, just not on screen. A fresh install follows the
 * OS - which is the right default, and the only way a machine that dims in the
 * evening takes the dashboard with it - and the first press of this switch
 * replaces that with an explicit choice. So the switch shows the RESOLVED
 * theme rather than the stored preference: while following the system it
 * reflects whatever the system currently says, which is what someone looking
 * at it would expect it to mean. Nothing is lost except a third control.
 *
 * A real `role="switch"` rather than a styled checkbox or a pair of buttons, so
 * it is announced as on/off with its current state and works from the keyboard
 * with no extra handling.
 *
 * THIS IS THE ONE COMPONENT ALLOWED TO BRANCH ON THE THEME. Everywhere else the
 * rule holds - components name tokens and the theme re-points them. Here the
 * component's entire job is to depict both themes at once, so it has to know
 * which one is active; a token cannot express "white knob when dark, navy knob
 * when light" because both states must be describable simultaneously.
 *
 * The motion is three things moving together: the knob travels, the track
 * changes colour, and the two icons rotate through each other rather than
 * swapping - the moon turning into the sun. 300ms is enough to read as one
 * object moving and short enough not to be waited for.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setPreference } = useTheme()
  const isDark = resolved === 'dark'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label="Dark mode"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setPreference(isDark ? 'light' : 'dark')}
      className={cn(
        'ease-soft relative inline-flex h-8 w-14 shrink-0 cursor-pointer items-center rounded-full p-1 transition-colors duration-300',
        isDark ? 'bg-panel-2' : 'bg-line-strong',
        className,
      )}
    >
      {/* Stars, dark only. Purely decorative - they carry no state the knob
          does not already carry - so they are hidden from assistive tech and
          fade rather than move, which keeps the eye on the knob. */}
      <span
        aria-hidden
        className={cn(
          'ease-soft pointer-events-none absolute inset-0 transition-opacity duration-300',
          isDark ? 'opacity-100' : 'opacity-0',
        )}
      >
        <span className="bg-ink absolute top-2 right-3 size-[2px] rounded-full opacity-70" />
        <span className="bg-ink absolute top-4 right-5 size-[2px] rounded-full opacity-50" />
        <span className="bg-ink absolute right-2.5 bottom-2 size-[3px] rounded-full opacity-60" />
      </span>

      {/* The knob. Travel is the track minus its padding minus the knob:
          56 - 8 - 24 = 24px, which is translate-x-6. */}
      <span
        className={cn(
          'ease-soft relative grid size-6 place-items-center rounded-full shadow-sm transition-transform duration-300',
          isDark ? 'bg-ink translate-x-0' : 'bg-panel translate-x-6',
        )}
      >
        {/* Both icons are always rendered and stacked, so one can rotate out
            while the other rotates in. Mounting and unmounting them instead
            would give a hard swap with nothing to animate between. */}
        <Moon
          aria-hidden
          className={cn(
            'text-canvas ease-soft absolute size-3.5 transition-all duration-300',
            isDark ? 'rotate-0 opacity-100' : '-rotate-90 opacity-0',
          )}
        />
        <Sun
          aria-hidden
          className={cn(
            'text-ink ease-soft absolute size-3.5 transition-all duration-300',
            isDark ? 'rotate-90 opacity-0' : 'rotate-0 opacity-100',
          )}
        />
      </span>
    </button>
  )
}
