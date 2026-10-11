import type { SVGProps } from 'react';

/**
 * The icon set, inline.
 *
 * No icon library: the app needs about thirty glyphs, and a dependency would
 * ship thousands. These are drawn on a 24-unit grid with a 1.5 stroke so they
 * sit at the same optical weight as the UI text — a mixed-weight icon set is
 * one of the things that makes an interface look assembled rather than designed.
 *
 * `currentColor` throughout, so an icon inherits its context and the theme
 * switch reaches it for free.
 */

export type IconName =
  | 'overview'
  | 'projects'
  | 'live'
  | 'analytics'
  | 'decisions'
  | 'strategies'
  | 'simulation'
  | 'data'
  | 'rules'
  | 'alerts'
  | 'audit'
  | 'api'
  | 'settings'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'check'
  | 'close'
  | 'copy'
  | 'plus'
  | 'search'
  | 'sun'
  | 'moon'
  | 'bell'
  | 'logout'
  | 'external'
  | 'warning'
  | 'critical'
  | 'info'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-right'
  | 'refresh'
  | 'play'
  | 'pause'
  | 'rollback'
  | 'shield'
  | 'sparkle'
  | 'upload'
  | 'download'
  | 'clock'
  | 'sidebar'
  | 'dot'
  | 'spinner';

const PATHS: Record<IconName, string> = {
  // ── navigation ──────────────────────────────────────────────────────────
  overview: 'M3 13h7V3H3v10Zm0 8h7v-5H3v5Zm11 0h7V11h-7v10Zm0-18v5h7V3h-7Z',
  projects: 'M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z',
  live: 'M12 12h.01M8.5 8.5a5 5 0 0 0 0 7m7-7a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13m13-13a9 9 0 0 1 0 13',
  analytics: 'M4 20V9m5 11V4m5 16v-7m5 7V7',
  decisions: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 1 0 6 0M9 5a2 2 0 1 1 6 0m-6 8h6m-6 4h4',
  strategies: 'M4 6h7l2 3h7M4 6v12h16V9M8 14h8',
  simulation: 'M12 3v4m0 10v4M3 12h4m10 0h4M6.5 6.5l2.8 2.8m5.4 5.4 2.8 2.8m0-11-2.8 2.8m-5.4 5.4-2.8 2.8',
  data: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  rules: 'M4 7h4m12 0h-8M4 17h10m6 0h-2M8 5v4m8 6v4',
  alerts: 'M12 3a6 6 0 0 0-6 6c0 4-2 5-2 5h16s-2-1-2-5a6 6 0 0 0-6-6Zm-2.5 14a2.5 2.5 0 0 0 5 0',
  audit: 'M8 4h8a2 2 0 0 1 2 2v14l-6-3-6 3V6a2 2 0 0 1 2-2Zm0 5h8m-8 4h5',
  api: 'M8 9l-4 3 4 3m8-6 4 3-4 3m-2-9-4 12',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8.4-3c0 .5 0 1-.1 1.4l2 1.5-2 3.4-2.3-1a8 8 0 0 1-2.4 1.4l-.3 2.4h-4l-.3-2.4a8 8 0 0 1-2.4-1.4l-2.3 1-2-3.4 2-1.5a9 9 0 0 1 0-2.8l-2-1.5 2-3.4 2.3 1a8 8 0 0 1 2.4-1.4L10.4 3h4l.3 2.4a8 8 0 0 1 2.4 1.4l2.3-1 2 3.4-2 1.5c.1.4.1.9.1 1.3Z',

  // ── controls ────────────────────────────────────────────────────────────
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  check: 'M4 12.5l5 5L20 6.5',
  close: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-4M4 10a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9Z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4 4',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-13v2m0 18v-2M3 12h2m18 0h-2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8L17 7m-10 10-1.4 1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  bell: 'M12 3a6 6 0 0 0-6 6c0 4-2 5-2 5h16s-2-1-2-5a6 6 0 0 0-6-6Zm-2.5 14a2.5 2.5 0 0 0 5 0',
  logout: 'M15 17l5-5-5-5m5 5H9m2 7H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
  external: 'M14 4h6v6m0-6L10 14M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',

  // ── status ──────────────────────────────────────────────────────────────
  warning: 'M12 4 2.5 20h19L12 4Zm0 5v6m0 3h.01',
  critical: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5m0 3h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5v-5m0-3h.01',
  'arrow-up': 'M12 19V5m0 0-6 6m6-6 6 6',
  'arrow-down': 'M12 5v14m0 0 6-6m-6 6-6-6',
  'arrow-right': 'M5 12h14m0 0-6-6m6 6-6 6',
  refresh: 'M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6',

  // ── lifecycle ───────────────────────────────────────────────────────────
  play: 'M7 4.5v15l13-7.5-13-7.5Z',
  pause: 'M8 5v14M16 5v14',
  rollback: 'M4 11a8 8 0 1 1 2.3 6.3M4 5v6h6',
  shield: 'M12 3 5 6v6c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Zm-2.5 9 2 2 3.5-4',
  sparkle: 'M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4Zm6.5 8.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z',
  upload: 'M12 16V4m0 0L7 9m5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  download: 'M12 4v12m0 0 5-5m-5 5-5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3.5 2',
  sidebar: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm5-2v16',
  dot: 'M12 12h.01',
  spinner: 'M12 3a9 9 0 1 0 9 9',
};

/** Icons drawn as a filled shape rather than a stroke. */
const FILLED = new Set<IconName>(['play']);

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Pixel size for both axes. Matches the text it sits beside. */
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, size = 18, strokeWidth = 1.6, ...rest }: IconProps) {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Icons are decorative by default: the adjacent label is what a screen
      // reader should announce. An icon-only control passes its own aria-label,
      // which overrides this through `rest`.
      aria-hidden="true"
      focusable="false"
      style={
        name === 'spinner'
          ? { animation: 'spin 0.7s linear infinite', ...(rest.style ?? {}) }
          : rest.style
      }
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
