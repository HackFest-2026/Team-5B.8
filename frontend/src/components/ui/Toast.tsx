import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import s from './Toast.module.css';

/**
 * Transient confirmations: "Strategy activated", "Rule saved".
 *
 * Used for things that SUCCEEDED and need acknowledging, not for errors that
 * need acting on — a failure belongs next to the control that failed, where the
 * user is looking, not in a corner that disappears after four seconds. The
 * `error` tone exists for background failures with no on-screen home (a live
 * action from a notification, say).
 */

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

interface ToastContextValue {
  show: (toast: Omit<Toast, 'id'>) => void;
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_ICON: Record<ToastTone, IconName> = {
  success: 'check',
  error: 'critical',
  info: 'info',
  warning: 'warning',
};

/** Errors stay longer: they carry more to read and may need to be acted on. */
const DURATION: Record<ToastTone, number> = {
  success: 4000,
  info: 4500,
  warning: 6000,
  error: 8000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  // Clear every pending timer on unmount so none fires into a dead component.
  useEffect(
    () => () => {
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId.current++;
      // Cap the stack. A loop that fails repeatedly would otherwise bury the
      // screen in identical cards.
      setToasts((list) => [...list, { ...toast, id }].slice(-4));
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), DURATION[toast.tone]),
      );
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      success: (title, body) => show({ tone: 'success', title, body }),
      error: (title, body) => show({ tone: 'error', title, body }),
      info: (title, body) => show({ tone: 'info', title, body }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          className={s.region}
          // polite, not assertive: a success confirmation must not interrupt
          // whatever a screen-reader user is currently hearing.
          role="status"
          aria-live="polite"
        >
          {toasts.map((t) => (
            <div key={t.id} className={`${s.toast} ${s[t.tone]}`}>
              <Icon
                name={TONE_ICON[t.tone]}
                size={16}
                strokeWidth={t.tone === 'success' ? 2.4 : 1.6}
                className={`${s.icon} ${s[`${t.tone}Icon`]}`}
              />
              <div className={s.content}>
                <div className={s.title}>{t.title}</div>
                {t.body && <div className={s.body}>{t.body}</div>}
              </div>
              <button
                type="button"
                className={s.dismiss}
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
