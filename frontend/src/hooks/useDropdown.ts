import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * An open/closed popover that dismisses itself properly.
 *
 * "Properly" means all three of these, which is why it is a hook rather than a
 * `useState(false)` at each call site:
 *
 *  - a click anywhere outside closes it
 *  - Escape closes it and returns focus to the trigger
 *  - the listeners only exist while it is open
 *
 * `mousedown` rather than `click` for the outside test: with `click`, pressing
 * on the trigger of an already-open menu would close it on the outside handler
 * and immediately reopen it on the trigger's own handler, so it would never
 * close.
 */
export function useDropdown<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<T>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const el = containerRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return { open, setOpen, toggle, close, containerRef, triggerRef };
}
