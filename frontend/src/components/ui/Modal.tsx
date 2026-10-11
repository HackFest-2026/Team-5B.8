import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, type ButtonVariant } from './Button';
import { ErrorState } from './Feedback';
import { Icon } from './Icon';
import type { DevNexusError } from '@/api/client';
import s from './Modal.module.css';

/**
 * An accessible modal dialog.
 *
 * What "accessible dialog" has to mean in practice, and what this does:
 *
 *  - rendered in a portal, so it is never clipped by an ancestor's overflow
 *  - `role="dialog" aria-modal`, labelled by its own title
 *  - focus moves in on open and returns to the trigger on close
 *  - focus is TRAPPED: tabbing past the last control wraps to the first, so a
 *    keyboard user cannot tab into the dashboard behind an open dialog
 *  - Escape closes, and the overlay closes only on a click that both started
 *    and ended on the overlay (a drag ending there must not dismiss it)
 *  - background scrolling is locked while open
 */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'wide' | 'xwide';
  /** Set for a confirmation the user must answer deliberately. */
  disableOverlayClose?: boolean;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  disableOverlayClose,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const pressedOnOverlay = useRef(false);
  const titleId = useId();

  // Remember the trigger, move focus in, and put it back on close. Without the
  // restore, closing a dialog drops focus to <body> and a keyboard user has to
  // tab from the top of the page again.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;

    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();

    return () => restoreFocusTo.current?.focus?.();
  }, [open]);

  // Lock background scroll. Restoring the previous value rather than clearing
  // it matters for nested dialogs, which would otherwise unlock on the inner
  // one's close.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return createPortal(
    <div
      className={s.overlay}
      // Tracking press and release separately: a click that began inside the
      // dialog and finished on the overlay (a text drag) must not dismiss it.
      onMouseDown={(e) => {
        pressedOnOverlay.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (disableOverlayClose) return;
        if (pressedOnOverlay.current && e.target === e.currentTarget) onClose();
        pressedOnOverlay.current = false;
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={[s.dialog, size === 'wide' ? s.wide : '', size === 'xwide' ? s.xwide : '']
          .filter(Boolean)
          .join(' ')}
        onKeyDown={onKeyDown}
      >
        <div className={s.head}>
          <div>
            <div className={s.title} id={titleId}>
              {title}
            </div>
            {subtitle && <div className={s.subtitle}>{subtitle}</div>}
          </div>
          <button type="button" className={s.close} onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        {children && <div className={s.body}>{children}</div>}
        {footer && <div className={s.foot}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ===========================================================================
   Confirmation
   =========================================================================== */

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  /** What the user is about to do, in their language. */
  body: ReactNode;
  /**
   * The irreversible part, spelled out.
   *
   * This exists because "Are you sure?" conveys nothing. "Live traffic will be
   * priced with v2 from the next request" is a sentence someone can actually
   * make a decision about.
   */
  consequence?: ReactNode;
  /** Key/value facts about the target, so the user can check they picked right. */
  details?: readonly { label: string; value: ReactNode }[];
  confirmLabel: string;
  variant?: ButtonVariant;
  pending?: boolean;
  error?: DevNexusError | null;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  consequence,
  details,
  confirmLabel,
  variant = 'dangerSolid',
  pending,
  error,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      // No accidental dismissal of a destructive decision.
      disableOverlayClose
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant={variant} loading={pending} onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div>{body}</div>

      {details && details.length > 0 && (
        <div className={s.summary}>
          {details.map((d) => (
            <div className={s.summaryRow} key={d.label}>
              <span className={s.summaryLabel}>{d.label}</span>
              <span className={s.summaryValue}>{d.value}</span>
            </div>
          ))}
        </div>
      )}

      {consequence && (
        <div className={s.consequence}>
          <Icon name="warning" size={16} className={s.consequenceIcon} />
          <div>{consequence}</div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 'var(--s-4)' }}>
          <ErrorState error={error} title="That did not go through" />
        </div>
      )}
    </Modal>
  );
}
