import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

/**
 * Catches a render crash so one broken component does not blank the whole app.
 *
 * This has to be a class: `componentDidCatch` has no hook equivalent, and
 * without it any exception thrown during render unmounts the entire tree and
 * leaves a white page with nothing to click.
 *
 * It is deliberately placed per route rather than once at the root. A crash in
 * the decisions table should leave the sidebar, the project switcher and the
 * theme toggle working so the user can navigate away — a single root boundary
 * would take those down too and the only recovery would be a manual reload.
 */

interface Props {
  children: ReactNode;
  /** Shown in the fallback, so the user knows what broke. */
  section?: string;
  /** Changing this resets the boundary — used to retry on navigation. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged rather than swallowed: the stack is the only way to diagnose this,
    // and the fallback intentionally does not show it to the user.
    console.error('Render error caught by boundary:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    // Navigating away from a broken screen should clear the error, otherwise the
    // fallback persists over the new route.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 'var(--s-3)',
          padding: 'var(--s-8) var(--s-5)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
        }}
      >
        <div
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 44,
            height: 44,
            borderRadius: 'var(--r-lg)',
            background: 'var(--critical-muted)',
            border: '1px solid color-mix(in srgb, var(--critical) 40%, transparent)',
            color: 'var(--critical-text)',
          }}
        >
          <Icon name="warning" size={20} />
        </div>

        <div style={{ fontSize: 'var(--t-base)', fontWeight: 560 }}>
          {this.props.section ? `${this.props.section} could not be displayed` : 'Something broke'}
        </div>

        <p
          style={{
            maxWidth: '46ch',
            fontSize: 'var(--t-sm)',
            color: 'var(--text-secondary)',
            lineHeight: 'var(--lh-normal)',
          }}
        >
          This is a bug in DevNexus, not something you did. Your pricing is unaffected — the engine
          runs on the server and does not depend on this page.
        </p>

        <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-2)' }}>
          <Button variant="primary" icon="refresh" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </div>

        {/* The message only — never the stack. A stack trace in the UI reads as a
            crashed product, and it is already in the console for whoever needs it. */}
        <code
          style={{
            marginTop: 'var(--s-3)',
            fontSize: 'var(--t-xs)',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {this.state.error.message.slice(0, 160)}
        </code>
      </div>
    );
  }
}
