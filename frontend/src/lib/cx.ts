/**
 * Join class names, dropping anything falsy.
 *
 * This exists because `noUncheckedIndexedAccess` is on, which makes every CSS
 * module lookup `string | undefined` — correctly, since a typo'd class name
 * really is undefined at runtime. Rather than weaken the flag (it catches real
 * bugs on API arrays and record lookups) or sprinkle non-null assertions, every
 * class list goes through here.
 */
export type ClassValue = string | undefined | null | false;

export function cx(...parts: ClassValue[]): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    out = out ? `${out} ${p}` : p;
  }
  return out;
}
