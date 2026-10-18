/**
 * Joins class names, dropping falsy ones.
 *
 * Deliberately not `clsx` — this is four lines and adding a dependency for it
 * would be a new package for something trivial.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
