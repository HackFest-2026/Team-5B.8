import {
  forwardRef,
  type CSSProperties,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon } from './Icon';
import s from './Field.module.css';

/**
 * Form controls.
 *
 * Every control is wired to its label and its error message through generated
 * ids, so a screen reader announces "Base price, invalid entry, must be greater
 * than zero" rather than just "edit text". Doing this by hand at each call site
 * is the kind of thing that gets skipped, so it lives here.
 */

interface FieldShellProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

function FieldShell({ label, hint, error, optional, children }: FieldShellProps) {
  const base = useId();
  const id = `${base}-control`;
  const hintId = hint ? `${base}-hint` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={s.field}>
      {label && (
        <label className={s.label} htmlFor={id}>
          {label}
          {optional && <span className={s.optional}>optional</span>}
        </label>
      )}
      {children({ id, describedBy, invalid: !!error })}
      {/* Under the control, not above it. Above, a hint on one field in a row
          pushes that field's input a line lower than its neighbours — which is
          exactly what happened to "Minimum margin" next to the other limits. */}
      {hint && (
        <div className={s.hint} id={hintId}>
          {hint}
        </div>
      )}
      {error && (
        <div className={s.error} id={errorId} role="alert">
          <Icon name="warning" size={11} strokeWidth={2} />
          {error}
        </div>
      )}
    </div>
  );
}

/* ── text / number input ─────────────────────────────────────────────── */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  /** A currency symbol or unit shown inside the control. */
  prefix?: string;
  suffix?: string;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, optional, prefix, suffix, mono, className, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional}>
      {({ id, describedBy, invalid }) => {
        const control = (
          <input
            ref={ref}
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={[
              s.control,
              invalid ? s.invalid : '',
              rest.type === 'number' ? s.numeric : '',
              mono ? s.mono : '',
              className ?? '',
            ]
              .filter(Boolean)
              .join(' ')}
            {...rest}
          />
        );
        if (!prefix && !suffix) return control;
        return (
          <div
            className={s.withPrefix}
            // The padding has to clear the affix, and an affix can be "₹" or
            // "INR". Measuring it in characters is what makes a three-letter
            // currency code stop overlapping the number.
            style={
              {
                '--affix-start': `${prefix?.length ?? 0}ch`,
                '--affix-end': `${suffix?.length ?? 0}ch`,
              } as CSSProperties
            }
          >
            {prefix && <span className={s.prefix}>{prefix}</span>}
            {control}
            {suffix && <span className={s.suffix}>{suffix}</span>}
          </div>
        );
      }}
    </FieldShell>
  );
});

/* ── textarea ────────────────────────────────────────────────────────── */

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, optional, className, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional}>
      {({ id, describedBy, invalid }) => (
        <textarea
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={[s.control, s.textarea, invalid ? s.invalid : '', className ?? '']
            .filter(Boolean)
            .join(' ')}
          {...rest}
        />
      )}
    </FieldShell>
  );
});

/* ── select ──────────────────────────────────────────────────────────── */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  options: readonly SelectOption[];
  /** A leading option that is not a value, e.g. "Choose an industry". */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, optional, options, placeholder, className, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional}>
      {({ id, describedBy, invalid }) => (
        <div className={s.selectWrap}>
          <select
            ref={ref}
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className={[s.control, s.select, invalid ? s.invalid : '', className ?? '']
              .filter(Boolean)
              .join(' ')}
            {...rest}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={14} className={s.selectChevron} />
        </div>
      )}
    </FieldShell>
  );
});

/* ── checkbox ────────────────────────────────────────────────────────── */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  hint?: ReactNode;
}

export function Checkbox({ label, hint, className, ...rest }: CheckboxProps) {
  return (
    <label className={[s.check, className ?? ''].filter(Boolean).join(' ')}>
      {/* The real input stays in the DOM and keeps focus and keyboard
          behaviour; only its appearance is replaced. */}
      <input type="checkbox" className="sr-only" {...rest} />
      <span className={s.checkBox} aria-hidden="true">
        <Icon name="check" size={11} strokeWidth={3} />
      </span>
      <span>
        <span className={s.checkLabel}>{label}</span>
        {hint && <span className={s.checkHint} style={{ display: 'block' }}>{hint}</span>}
      </span>
    </label>
  );
}

/* ── search ──────────────────────────────────────────────────────────── */

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <div className={s.search}>
      <Icon name="search" size={15} className={s.searchIcon} />
      <input
        type="search"
        className={s.control}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
    </div>
  );
}

/* ── layout helpers ──────────────────────────────────────────────────── */

/** Side-by-side fields that collapse to one column when narrow. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className={s.row}>{children}</div>;
}

export function FieldStack({ children }: { children: ReactNode }) {
  return <div className={s.stack}>{children}</div>;
}

/* ── segmented control ───────────────────────────────────────────────── */

/**
 * The time-range picker and similar small exclusive choices.
 *
 * Radio semantics rather than buttons, so arrow keys move between options the
 * way a keyboard user expects of a single-choice control.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={s.segmented} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={[s.segment, o.value === value ? s.segmentActive : ''].filter(Boolean).join(' ')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
