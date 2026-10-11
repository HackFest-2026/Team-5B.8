import { useEffect, useRef, useState } from 'react';

/**
 * Reveal an element once it scrolls into view.
 *
 * Two things this gets right that a naive version does not:
 *
 *  - It disconnects after the first reveal. A section that fades back out when
 *    you scroll up is distracting, and keeping observers alive on a long page
 *    costs for no benefit.
 *  - It respects `prefers-reduced-motion` by reporting "revealed" immediately,
 *    so reduced-motion users see complete content rather than content that never
 *    animates in and therefore stays at opacity 0.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(options?: {
  threshold?: number;
  rootMargin?: string;
}) {
  const ref = useRef<T>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // No IntersectionObserver (or motion is unwanted): show it now. Failing
    // closed here would leave the whole page invisible.
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setRevealed(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRevealed(true);
            observer.disconnect();
          }
        }
      },
      {
        threshold: options?.threshold ?? 0.12,
        // A negative bottom margin starts the animation slightly before the
        // element reaches the fold, so it is finished by the time it is being
        // read rather than animating under the reader's eyes.
        rootMargin: options?.rootMargin ?? '0px 0px -8% 0px',
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [options?.threshold, options?.rootMargin]);

  return { ref, revealed };
}
