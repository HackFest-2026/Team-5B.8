import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import s from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconAfter?: IconName;
  block?: boolean;
  /** Shows a spinner and blocks further clicks. */
  loading?: boolean;
  children?: ReactNode;
  className?: string;
}

export interface ButtonProps
  extends CommonProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> {}

function classes(p: CommonProps, hasChildren: boolean): string {
  return [
    s.btn,
    s[p.variant ?? 'secondary'],
    s[p.size ?? 'md'],
    p.block ? s.block : '',
    !hasChildren ? s.iconOnly : '',
    p.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Leading slot: the spinner takes the icon's place so width does not change. */
function Leading({ loading, icon, size }: { loading?: boolean; icon?: IconName; size: number }) {
  if (loading) return <Icon name="spinner" size={size} className={s.spinner} />;
  if (icon) return <Icon name={icon} size={size} />;
  return null;
}

const ICON_SIZE: Record<ButtonSize, number> = { sm: 13, md: 15, lg: 17 };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size = 'md', icon, iconAfter, block, loading, children, className, ...rest },
  ref,
) {
  const iconSize = ICON_SIZE[size];
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      // A loading button must not be clickable twice: a second /strategies/promote
      // while the first is in flight is a real double-apply, not a cosmetic issue.
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      className={classes({ variant, size, block, className }, children !== undefined)}
      {...rest}
    >
      <Leading loading={loading} icon={icon} size={iconSize} />
      {children}
      {iconAfter && !loading && <Icon name={iconAfter} size={iconSize} />}
    </button>
  );
});

export interface LinkButtonProps extends CommonProps {
  to: string;
  'aria-label'?: string;
  onClick?: () => void;
}

/** The same visual control, as a router link. Navigation stays a real anchor so
 *  middle-click and open-in-new-tab keep working. */
export function LinkButton({
  to,
  variant,
  size = 'md',
  icon,
  iconAfter,
  block,
  children,
  className,
  ...rest
}: LinkButtonProps) {
  const iconSize = ICON_SIZE[size];
  return (
    <Link
      to={to}
      className={classes({ variant, size, block, className }, children !== undefined)}
      {...rest}
    >
      {icon && <Icon name={icon} size={iconSize} />}
      {children}
      {iconAfter && <Icon name={iconAfter} size={iconSize} />}
    </Link>
  );
}

export interface ExternalButtonProps extends CommonProps {
  href: string;
}

export function ExternalButton({
  href,
  variant,
  size = 'md',
  icon,
  children,
  className,
}: ExternalButtonProps) {
  return (
    <a
      href={href}
      target="_blank"
      // noreferrer alongside noopener: without it the target page receives the
      // referring URL, which for an authenticated app can leak ids in the path.
      rel="noopener noreferrer"
      className={classes({ variant, size, className }, children !== undefined)}
    >
      {icon && <Icon name={icon} size={ICON_SIZE[size]} />}
      {children}
      <Icon name="external" size={ICON_SIZE[size] - 2} />
    </a>
  );
}
