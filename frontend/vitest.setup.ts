import { afterEach } from 'vitest'
import { clearSession } from '@/api/tokenStore'
import '@testing-library/jest-dom/vitest'

/**
 * jsdom 26 implements <dialog> but not showModal() / close().
 *
 * Native <dialog> is deliberate in the app - it brings focus trapping, Escape
 * handling and inertness of the rest of the page, all of which are easy to get
 * wrong by hand and are what make a modal usable by keyboard. Dropping it to
 * suit the test environment would be the tail wagging the dog, so the two
 * missing methods are filled in here instead.
 *
 * This is a shim, not a reimplementation: it only tracks openness so components
 * can be rendered and queried. It does NOT emulate focus trapping, so tests
 * must not assert on that - a real browser is the only place to check it.
 */
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(
    this: HTMLDialogElement,
    returnValue?: string,
  ) {
    this.open = false
    if (returnValue !== undefined) this.returnValue = returnValue
    this.dispatchEvent(new Event('close'))
  }
}

/**
 * The session now persists in sessionStorage, which jsdom keeps for the whole
 * file. Without this, a test that signs in would leave its session behind for
 * the next test's provider to restore.
 */
afterEach(() => {
  clearSession()
  try {
    sessionStorage.clear()
  } catch {
    /* nothing to clear */
  }
})
