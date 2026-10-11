import { cx } from '@/lib/cx';

/**
 * The DevNexus mark.
 *
 * A "D" drawn as a node with a path through it — the product's whole idea is
 * signal in, decision out, so the mark is that, not a generic abstract glyph.
 * Drawn rather than imported so it inherits the theme and stays crisp at 20px.
 */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="7"
        fill="var(--surface)"
        stroke="var(--border-strong)"
        strokeWidth="1.5"
      />
      <path
        d="M10 22.5V9.5h5a6.5 6.5 0 0 1 0 13h-5Z"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <circle cx="22.5" cy="16" r="1.9" fill="var(--accent)" />
    </svg>
  );
}

export function Logo({
  size = 26,
  showWordmark = true,
  className,
}: {
  size?: number;
  showWordmark?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(className)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-3)' }}
    >
      <LogoMark size={size} />
      {showWordmark && (
        <span
          style={{
            fontSize: 'var(--t-base)',
            fontWeight: 'var(--w-bold)',
            // Tightened tracking: a wordmark set at body tracking reads as a
            // sentence rather than a name.
            letterSpacing: '-0.02em',
            color: 'var(--text)',
          }}
        >
          DevNexus
        </span>
      )}
    </span>
  );
}
