import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Theme state.
 *
 * `system` is a real third option, not a synonym for dark: a user who has not
 * chosen should follow their OS, and someone who explicitly picked dark should
 * stay dark even when their OS flips at sunset. Only an explicit choice is
 * persisted, and only an explicit choice sets `data-theme` — which is what lets
 * the `prefers-color-scheme` block in tokens.css apply.
 */
export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'devnexus.theme';

interface ThemeContextValue {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
  /** Flip between dark and light, landing on an explicit choice either way. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * The product is dark, full stop.
 *
 * The light theme and the machinery around it are left intact — the tokens, the
 * provider and `setPreference` all still work — but there is no longer any
 * control that reaches them, so reading a stored preference would strand anyone
 * who had previously chosen light with no way back. Returning dark unconditionally
 * is what makes removing the toggle safe rather than a trap.
 */
function readStored(): ThemePreference {
  return 'dark';
}

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPref] = useState<ThemePreference>(readStored);
  const [systemValue, setSystemValue] = useState<ResolvedTheme>(systemTheme);

  // Follow the OS only while the preference is `system`; the listener stays
  // attached regardless so switching back to `system` is immediate.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => setSystemValue(e.matches ? 'light' : 'dark');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme: ResolvedTheme = preference === 'system' ? systemValue : preference;

  useEffect(() => {
    const root = document.documentElement;
    if (preference === 'system') {
      // Remove the attribute so the media query in tokens.css takes over,
      // rather than pinning a value that would stop tracking the OS.
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', preference);
    }
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      /* memory-only preference */
    }
  }, [preference]);

  const setPreference = useCallback((p: ThemePreference) => setPref(p), []);
  const toggle = useCallback(
    () => setPref(theme === 'dark' ? 'light' : 'dark'),
    [theme],
  );

  const value = useMemo(
    () => ({ preference, theme, setPreference, toggle }),
    [preference, theme, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
