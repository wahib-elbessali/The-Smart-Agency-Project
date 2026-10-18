import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { Bell, Camera, Eye, EyeOff, UserCheck, Users } from 'lucide-react'
import { useSession } from '@/auth/SessionContext'
import { USE_MOCKS } from '@/api/config'
import { ApiError, describeApiError } from '@/api/errors'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/Button'
import { controlClass } from '@/components/ui/control'
import { cn } from '@/components/ui/cn'
import { ThemeToggle } from '@/components/ThemeToggle'

/**
 * Sign-in.
 *
 * THE ONE SCREEN ALLOWED A LITTLE BRAND (2026-10-10). Every other screen keeps
 * a flat canvas because the data is the only thing that should carry weight.
 * This one has no data, and it is the first thing anyone sees, so on a wide
 * screen it splits: a quiet brand panel on the left (the mark, the name, what
 * the product watches), the form on the right. Still no gradients, glows or
 * texture - the panel is the ordinary surface colour, and the only decoration
 * is the mark itself. Below lg the brand panel drops away and the form stands
 * alone with the wordmark above it, as before.
 *
 * Small things that matter more than the look:
 *   - Show/hide on the password, because a mistyped password on a shared wall
 *     display is otherwise invisible.
 *   - A Caps Lock warning, read from the key event (getModifierState), shown
 *     only while the password field has focus.
 *   - No "Forgot password?" link. There is no reset endpoint in the contract,
 *     and a link to nothing is worse than none, so the screen says who can
 *     actually help: the administrator.
 *
 * Mock mode only: the fixture accounts are listed, and clicking one fills the
 * email (passwords are never checked against fixtures). Styled as a dashed,
 * secondary box so it never reads as part of the real form.
 */
const MOCK_ACCOUNTS = [
  { email: 'admin@test.com', role: 'ADMIN' },
  { email: 'leila@agency.com', role: 'MANAGER' },
  { email: 'nadia@agency.com', role: 'AGENT' },
  { email: 'mehdi@agency.com', role: 'SECURITY' },
  { email: 'karim@agency.com', role: 'TECHNICIAN' },
] as const

/* What the product watches, said plainly. Each line is a real screen. */
const WATCHES = [
  { icon: UserCheck, text: 'Who is in the building, and who arrived late' },
  { icon: Users, text: 'The visitor queue at every counter' },
  { icon: Camera, text: 'Cameras, zones and occupancy' },
  { icon: Bell, text: 'Security alerts the moment they open' },
] as const

interface FromState {
  from?: string
}

export default function Login() {
  const { signIn, status } = useSession()
  const navigate = useNavigate()
  const location = useLocation()

  /* Where RequireAuth bounced us from, so signing in returns you to the screen
     you actually wanted instead of dumping you on the default one. Falling
     back to "/" lets the index route turn the role into a starting screen
     (auth/landing.ts). */
  const from = (location.state as FromState | null)?.from ?? '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await signIn({ email, password })
      void navigate(from, { replace: true })
    } catch (cause) {
      setError(
        cause instanceof ApiError ? describeApiError(cause) : 'Could not sign in. Try again.',
      )
    } finally {
      setPending(false)
    }
  }

  const readCapsLock = (event: KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(event.getModifierState('CapsLock'))

  /* Already signed in - typically a new tab that just picked the session up from
     another one. Nothing to do on a sign-in screen. */
  if (status === 'authenticated') return <Navigate to={from} replace />

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Brand panel - wide screens only. */}
      <aside className="bg-panel border-line hidden flex-col justify-between border-r p-12 lg:flex">
        <Wordmark />

        <div className="max-w-md">
          <Logo size={64} pulse />
          <h2 className="text-ink mt-8 text-2xl leading-snug">Every branch, in one calm view.</h2>
          <p className="text-ink-2 mt-3 text-sm leading-relaxed">
            The operations dashboard for your agencies - watching the sensors, cameras and queues so
            you can see at a glance whether anything needs you.
          </p>
          <ul className="mt-8 space-y-3">
            {WATCHES.map(({ icon: Icon, text }) => (
              <li key={text} className="text-ink-2 flex items-center gap-3 text-sm">
                <Icon className="text-ink-3 size-4 shrink-0" aria-hidden />
                {text}
              </li>
            ))}
          </ul>
        </div>

        <Footer />
      </aside>

      {/* Form side. */}
      <main className="relative flex flex-col items-center justify-center px-6 py-12">
        {/* Top-right, away from the form: someone arriving at a wall display at
            night should be able to dim it without signing in first. */}
        <div className="absolute top-6 right-6">
          <ThemeToggle />
        </div>

        <div className="animate-fade-rise w-full max-w-sm">
          <div className="mb-10 flex justify-center lg:hidden">
            <Wordmark />
          </div>

          <h1 className="text-ink text-xl">Sign in</h1>
          <p className="text-ink-2 mt-1 text-sm">Use the account your administrator gave you.</p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div>
              <label htmlFor="email" className="text-ink-2 mb-2 block text-sm">
                Email
              </label>
              <input
                id="email"
                name="email"
                /* type="email" gives the right mobile keyboard and a free format
                   check; autoComplete="username" is what password managers look
                   for, even on an email field. */
                type="email"
                autoComplete="username"
                placeholder="name@agency.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={controlClass()}
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="text-ink-2 mb-2 block text-sm">
                Password
              </label>
              <div className="relative">
                <input
                  ref={passwordRef}
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={readCapsLock}
                  onKeyUp={readCapsLock}
                  onBlur={() => setCapsLock(false)}
                  aria-describedby={capsLock ? 'caps-lock-note' : undefined}
                  className={cn(controlClass(), 'pr-10')}
                  required
                />
                <button
                  type="button"
                  onClick={() => {
                    setShowPassword((value) => !value)
                    passwordRef.current?.focus()
                  }}
                  aria-pressed={showPassword}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                  className="text-ink-3 hover:text-ink ease-soft absolute inset-y-0 right-0 grid w-10 cursor-pointer place-items-center rounded-r-[var(--radius-control)] transition-colors duration-150"
                >
                  {showPassword ? (
                    <EyeOff className="size-4" aria-hidden />
                  ) : (
                    <Eye className="size-4" aria-hidden />
                  )}
                </button>
              </div>
              <p
                id="caps-lock-note"
                aria-live="polite"
                className={cn('text-warn mt-2 text-xs', !capsLock && 'sr-only')}
              >
                {capsLock ? 'Caps Lock is on.' : ''}
              </p>
            </div>

            {error && (
              <p
                role="alert"
                className="border-danger/30 bg-danger/8 text-danger rounded-lg border p-3 text-sm"
              >
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" disabled={pending} className="w-full">
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="text-ink-3 mt-6 text-center text-xs">
            Forgot your password? Ask your administrator to reset it.
          </p>

          {USE_MOCKS && (
            <section
              aria-labelledby="fixture-accounts"
              className="border-line-strong mt-10 rounded-lg border border-dashed p-4"
            >
              <h2 id="fixture-accounts" className="text-ink-3 tracked text-[10px] font-medium">
                Fixture accounts
              </h2>
              <p className="text-ink-3 mt-1 text-xs leading-relaxed">
                No backend is connected. Any password works - pick an email to fill it in.
              </p>
              <ul className="mt-3 space-y-1">
                {MOCK_ACCOUNTS.map((account) => (
                  <li key={account.email}>
                    <button
                      type="button"
                      onClick={() => {
                        setEmail(account.email)
                        passwordRef.current?.focus()
                      }}
                      className="hover:bg-panel-2 ease-soft flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1 text-xs transition-colors duration-150"
                    >
                      <span className="text-ink-2 font-mono">{account.email}</span>
                      <span className="text-ink-3">{account.role}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="mt-10 lg:hidden">
            <Footer />
          </div>
        </div>
      </main>
    </div>
  )
}

function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <Logo size={28} />
      <span className="text-ink font-display text-lg font-semibold tracking-wide">
        Smart<span className="text-ink-3 font-normal">Agency</span>
      </span>
    </div>
  )
}

/* True of every deployment: the whole stack runs on one machine at the site,
   which for a bank is reassurance worth saying out loud. */
function Footer() {
  return (
    <p className="text-ink-3 text-xs">Runs locally on this site&apos;s own server · no cloud</p>
  )
}
