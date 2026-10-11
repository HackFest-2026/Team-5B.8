/**
 * Display formatting.
 *
 * Centralised because the same number must look the same everywhere: a price in
 * a KPI card, in a decision row and in a chart tooltip are the same quantity,
 * and three slightly different renderings of it make the product feel sloppy.
 *
 * Currency is a PARAMETER, never assumed. The platform is multi-tenant and
 * multi-currency — the project's own currency comes back on every response that
 * contains money, and hardcoding ₹ would be wrong for most tenants.
 */

const SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AED: 'د.إ',
  SGD: 'S$',
  AUD: 'A$',
  JPY: '¥',
};

export function currencySymbol(code: string | null | undefined): string {
  if (!code) return '';
  return SYMBOLS[code] ?? `${code} `;
}

// Intl formatter construction is not free and these run inside render and chart
// tooltips, so each formatter is built once and reused. Numbers and dates get
// separate caches: one shared map would have to be typed as the union and every
// call site would need a cast to use the result.
const numCache = new Map<string, Intl.NumberFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();

function fmt(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = numCache.get(key);
  if (!f) {
    f = make();
    numCache.set(key, f);
  }
  return f;
}

function dfmt(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = dateCache.get(key);
  if (!f) {
    f = make();
    dateCache.set(key, f);
  }
  return f;
}

/**
 * A price or a revenue figure.
 *
 * `null` renders as an em dash rather than "0". The difference between "no
 * decision yet" and "a price of zero" is one an analyst must be able to see.
 */
export function money(
  value: number | null | undefined,
  currency: string | null | undefined,
  opts: { decimals?: number; compact?: boolean } = {},
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sym = currencySymbol(currency);

  if (opts.compact && Math.abs(value) >= 1000) {
    return `${sym}${compactNumber(value)}`;
  }

  // Prices need cents; totals in the millions do not. Default on magnitude so
  // a KPI card is not 11 characters of noise.
  const decimals =
    opts.decimals ?? (Math.abs(value) >= 10_000 ? 0 : Number.isInteger(value) ? 0 : 2);

  const f = fmt(`n:${decimals}`, () =>
    new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }),
  );
  return `${sym}${f.format(value)}`;
}

/** 1_240_000 → "1.24M". For KPI cards and axis labels. */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${trim(abs / 1e3)}K`;
  return String(value);
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2).replace(/0$/, '');
}

export function number(
  value: number | null | undefined,
  decimals = 0,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const f = fmt(`p:${decimals}`, () =>
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }),
  );
  return f.format(value);
}

/**
 * A percentage that already arrives as a percentage (8.5 → "8.5%").
 *
 * `signed` prepends "+" for gains, which is what a change figure needs — "8.5%"
 * and "+8.5%" read very differently next to a price.
 */
export function percent(
  value: number | null | undefined,
  opts: { decimals?: number; signed?: boolean } = {},
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const d = opts.decimals ?? (Math.abs(value) < 10 ? 1 : 0);
  const sign = opts.signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(d)}%`;
}

/** Latency. Sub-millisecond precision matters on the hot path. */
export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 100) return `${value.toFixed(1)} ms`;
  if (value < 1000) return `${value.toFixed(0)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

/* ── time ───────────────────────────────────────────────────────────────── */

/** Clock time, for a live timeline where the date is implicit. */
export function clockTime(tsMs: number | null | undefined): string {
  if (!tsMs) return '—';
  const f = dfmt('clock', () =>
    new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),
  );
  return f.format(new Date(tsMs));
}

/** Date and time, for audit rows and decision detail. */
export function dateTime(tsMs: number | null | undefined): string {
  if (!tsMs) return '—';
  const f = dfmt('datetime', () =>
    new Intl.DateTimeFormat(undefined, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
  );
  return f.format(new Date(tsMs));
}

export function dateOnly(tsMs: number | null | undefined): string {
  if (!tsMs) return '—';
  const f = dfmt('date', () =>
    new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
  );
  return f.format(new Date(tsMs));
}

/**
 * "12s ago", "4m ago".
 *
 * Live feeds are read by someone watching them happen, and an absolute
 * timestamp forces them to do arithmetic to answer "is this current?".
 */
export function relativeTime(tsMs: number | null | undefined, nowMs = Date.now()): string {
  if (!tsMs) return '—';
  const diff = Math.max(0, nowMs - tsMs);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return dateOnly(tsMs);
}

/** A duration in seconds, for "ran for 4m 12s". */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** An ISO date for the `date_from` / `date_to` backtest params. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ── identifiers and labels ─────────────────────────────────────────────── */

/**
 * Shorten a long identifier for a dense table, keeping both ends.
 *
 * Both ends, because DevNexus ids share a prefix (`prj_`, `str_`, `DEC-`) — a
 * truncation that keeps only the front would render several different ids
 * identically on screen.
 */
export function shortId(id: string | null | undefined, keep = 6): string {
  if (!id) return '—';
  if (id.length <= keep * 2 + 1) return id;
  return `${id.slice(0, keep)}…${id.slice(-keep)}`;
}

/** `price_changes` → `Price changes`. For metric names coming from the API. */
export function humanise(key: string | null | undefined): string {
  if (!key) return '';
  const s = key.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Pluralise without the "1 items" mistake. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${number(n)} ${n === 1 ? one : many}`;
}

/** Which semantic colour a change figure should use. */
export function changeTone(value: number | null | undefined): 'up' | 'down' | 'flat' {
  if (value === null || value === undefined || Math.abs(value) < 0.005) return 'flat';
  return value > 0 ? 'up' : 'down';
}
