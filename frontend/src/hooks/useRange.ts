import { useState } from 'react';
import type { TimeRange } from '@/api/endpoints';

/**
 * The time-range selector, shared by every screen that has one.
 *
 * The options are exactly what `/analytics/*` accepts. Keeping them in one place
 * means a screen cannot offer a window the server will reject, and the selected
 * range is remembered so moving between the dashboard and analytics does not
 * silently change what the numbers cover.
 */
export const RANGE_OPTIONS: readonly { value: TimeRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

const KEY = 'devnexus.range';

function readStored(): TimeRange {
  try {
    const raw = localStorage.getItem(KEY);
    if (RANGE_OPTIONS.some((o) => o.value === raw)) return raw as TimeRange;
  } catch {
    /* fall through */
  }
  return '24h';
}

export function useRange(initial?: TimeRange) {
  const [range, setRangeState] = useState<TimeRange>(() => initial ?? readStored());

  const setRange = (next: TimeRange) => {
    setRangeState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* applies for this session only */
    }
  };

  return { range, setRange, RANGE_OPTIONS };
}

/** The matching bucket size for a range, so charts are neither sparse nor noisy. */
export function intervalFor(range: TimeRange): '1m' | '5m' | '15m' | '1h' | '1d' {
  switch (range) {
    case '1h':
      return '1m';
    case '6h':
      return '5m';
    case '24h':
      return '1h';
    case '7d':
      return '1h';
    case '30d':
      return '1d';
  }
}
