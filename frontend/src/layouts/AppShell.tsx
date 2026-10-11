import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { alertsApi } from '@/api/endpoints';
import { prefetchRoute } from '@/App';
import { CommandPalette } from '@/components/CommandPalette';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Logo, LogoMark } from '@/components/Logo';
import { PricingSwitch } from '@/components/PricingSwitch';
import { Badge, LiveIndicator, ModeBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { ApprovalsProvider, useApprovals } from '@/hooks/useApprovals';
import { useAsync } from '@/hooks/useAsync';
import { useDropdown } from '@/hooks/useDropdown';
import { LiveProvider, useLive } from '@/hooks/useLive';
import { ProjectAgent } from '@/components/ProjectAgent';
import { ProjectAgentProvider } from '@/hooks/useProjectAgent';
import { useSession } from '@/hooks/useSession';
import { cx } from '@/lib/cx';
import { relativeTime } from '@/lib/format';
import s from './AppShell.module.css';

/**
 * The application shell: sidebar, top bar, and the live socket for the current
 * project.
 *
 * The navigation answers "where am I?" at a glance — one accented row, nothing
 * else competing — and the top bar answers "what am I looking at, and is it
 * live?", which are the two questions the spec insists must always be visible.
 */

interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  /** `end` so /app does not stay highlighted on every child route. */
  end?: boolean;
  /** Hidden until the account has at least one project. */
  needsProjects?: boolean;
}

interface NavGroup {
  label: string | null;
  items: NavEntry[];
}

/**
 * The navigation is CONTEXTUAL: it shows what the current scope can act on.
 *
 * On the account's own screens there is no project to configure, so offering
 * Products, Rules and Live there is offering to edit something the user has not
 * chosen yet — and whichever project happened to be remembered would silently
 * be the one edited. Those entries appear once a project is open.
 *
 * Inside a project the groups follow the product lifecycle — configure, then
 * watch — so the sidebar itself teaches the order things happen in.
 */
const ACCOUNT_NAV: NavGroup[] = [
  {
    label: null,
    items: [
      // One screen, not two. The dashboard holds the account's status AND the
      // project cards, so there is nowhere else for an account-level user to go.
      { to: '/app', label: 'Dashboard', icon: 'overview', end: true },
      { to: '/app/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

/**
 * Inside a project: five destinations, no group headings.
 *
 * Overview, Live and Decisions used to be three items answering one question —
 * "what is this project doing right now" — so they are one Dashboard. The way
 * back out is the project switcher in the bar, not a nav row, because leaving
 * is not one of the things you do to a project.
 */
const PROJECT_NAV: NavGroup[] = [
  {
    label: null,
    items: [
      // `end`, or Dashboard stays highlighted on /app/project/settings too.
      { to: '/app/project', label: 'Dashboard', icon: 'overview', end: true },
      { to: '/app/analytics', label: 'Analytics', icon: 'analytics' },
      { to: '/app/alerts', label: 'Alerts', icon: 'alerts' },
      { to: '/app/items', label: 'Products', icon: 'projects' },
      { to: '/app/rules', label: 'Rules', icon: 'rules' },
      { to: '/app/schema', label: 'Schema', icon: 'data' },
      { to: '/app/project/playground', label: 'Playground', icon: 'simulation' },
      { to: '/app/project/settings', label: 'Guardrails', icon: 'shield' },
      { to: '/app/api', label: 'API', icon: 'api' },
      // Auditability is a first-class concern — who changed what, and when —
      // so the trail is a visible destination, not only a command-palette jump.
      { to: '/app/audit', label: 'Audit', icon: 'audit' },
    ],
  },
];

/**
 * Account-level routes. Being ON one of these is what makes the shell show the
 * account navigation, regardless of which project is remembered — so the home
 * page and account settings never offer project controls.
 */
const ACCOUNT_PATHS = new Set(['/app', '/app/settings']);

const COLLAPSE_KEY = 'devnexus.sidebar.collapsed';

export function AppShell() {
  return (
    // The socket belongs to the shell, so it opens once on entry and closes on
    // exit rather than being re-established by each page that needs it.
    <LiveProvider>
      {/* Approvals are fetched once here and shared by the bell, the dashboard
          and the alerts page, instead of each one calling the endpoint. */}
      <ApprovalsProvider>
        {/* One in-project assistant for the whole shell — it survives tab
            changes and can drive navigation, so it lives here, not per page. */}
        <ProjectAgentProvider>
          <ShellInner />
          <ProjectAgent />
        </ProjectAgentProvider>
      </ApprovalsProvider>
    </LiveProvider>
  );
}

function ShellInner() {
  const { projectId, project, projects } = useSession();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* preference applies for this session only */
    }
  }, [collapsed]);

  // Close the mobile drawer on navigation. Leaving it open after a tap means
  // the destination is hidden behind the menu the user just used.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  // A project is "open" when the route is a project route — not merely when one
  // is remembered in localStorage.
  const inProject = !ACCOUNT_PATHS.has(location.pathname);
  const nav = inProject && project ? PROJECT_NAV : ACCOUNT_NAV;

  /**
   * The alert count on the sidebar badge.
   *
   * Polled rather than purely socket-driven: the socket only delivers alerts
   * raised while this tab is connected, so a count that relied on it alone
   * would read zero for an alert raised five minutes before the user arrived.
   */
  const openAlerts = useAsync(
    (signal) =>
      alertsApi.list({ project_id: projectId ?? undefined, status: 'open', limit: 1 }, { signal }),
    [projectId],
    { enabled: !!projectId, pollMs: 60_000 },
  );

  // From `summary.by_status`, not from the array length: the array is capped by
  // `limit`, so counting it would silently stop at the page size and report 50
  // when there are 200.
  const alertCount = openAlerts.data?.summary?.by_status?.open ?? 0;

  return (
    <div className={cx(s.shell, collapsed && s.shellCollapsed)}>
      {drawerOpen && (
        <div className={s.scrim} onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      )}

      <nav
        className={cx(s.sidebar, collapsed && s.collapsed, drawerOpen && s.sidebarOpen)}
        aria-label="Main navigation"
      >
        <div className={s.brand}>
          {collapsed ? (
            <Link to="/app" aria-label="DevNexus overview" style={{ margin: '0 auto' }}>
              <LogoMark size={24} />
            </Link>
          ) : (
            <Link to="/app" aria-label="DevNexus overview">
              <Logo size={24} />
            </Link>
          )}
          {!collapsed && (
            <button
              type="button"
              className={cx(s.collapseBtn, s.desktopOnly)}
              onClick={() => setCollapsed(true)}
              aria-label="Collapse sidebar"
            >
              <Icon name="sidebar" size={15} />
            </button>
          )}
        </div>

        <div className={s.nav}>
          {collapsed && (
            <button
              type="button"
              className={cx(s.navItem, s.desktopOnly)}
              onClick={() => setCollapsed(false)}
              aria-label="Expand sidebar"
            >
              <Icon name="chevron-right" size={16} className={s.navIcon} />
              <span className={s.tip}>Expand</span>
            </button>
          )}

          {nav.map((group, gi) => (
            <div key={group.label ?? `group-${gi}`} style={{ display: 'contents' }}>
              {group.label && <div className={s.navGroupLabel}>{group.label}</div>}
              {group.items.map((item) => {
                if (item.needsProjects && projects.length === 0) return null;
                const isAlerts = item.to === '/app/alerts';
                const badge = isAlerts && alertCount > 0 ? alertCount : null;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    // Start downloading the page's chunk on hover, so the click
                    // itself has nothing left to wait for.
                    onMouseEnter={() => prefetchRoute(item.to)}
                    onFocus={() => prefetchRoute(item.to)}
                    className={({ isActive }) =>
                      cx(
                        s.navItem,
                        isActive && s.navItemActive,
                        badge !== null && s.navItemAlert,
                      )
                    }
                  >
                    <Icon name={item.icon} size={16} className={s.navIcon} />
                    <span className={s.navLabel}>{item.label}</span>
                    {badge !== null && (
                      <span className={s.navBadge} aria-label={`${badge} open alerts`}>
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                    <span className={s.tip} role="tooltip">
                      {item.label}
                    </span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </div>

        <SidebarFooter />
      </nav>

      <div className={s.main}>
        <header className={s.topbar}>
          <div className={s.topbarLeft}>
            <button
              type="button"
              className={cx(s.collapseBtn, s.mobileOnly)}
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
            >
              <Icon name="sidebar" size={16} />
            </button>
            <ProjectSwitcher />
          </div>

          <div className={s.topbarRight}>
            {/* The switch sits in the bar, beside the live indicator it governs:
                it is the single most consequential control in the product, and
                it belongs where the current project is named rather than buried
                in a drawer that collapses. Only inside a project — on account
                screens there is no one system this would switch. */}
            {project && inProject && <PricingSwitch inline />}
            <LiveStatus />
            <PendingBell />
          </div>
        </header>

        <main className={s.content}>
          {/* Keyed on the path so navigating away from a crashed screen clears
              the fallback instead of pinning it over the new route. */}
          <ErrorBoundary resetKey={location.pathname} section="This page">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Sidebar footer: who is signed in
   ═══════════════════════════════════════════════════════════════════════ */

function SidebarFooter() {
  const { user, tenant, signOut } = useSession();
  const navigate = useNavigate();
  const menu = useDropdown<HTMLDivElement>();

  const initials =
    (user?.name || user?.email || '?')
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0] ?? '')
      .join('') || '?';

  return (
    <div className={s.sidebarFoot}>
      <div className={s.switcher} ref={menu.containerRef}>
        <button
          type="button"
          ref={menu.triggerRef}
          className={s.userRow}
          onClick={menu.toggle}
          aria-expanded={menu.open}
          aria-haspopup="menu"
        >
          <span className={s.avatar} aria-hidden="true">
            {initials}
          </span>
          <span className={s.userText}>
            <span className={s.userName}>{user?.name || user?.email || 'Account'}</span>
            <span className={s.userCompany}>{tenant?.company_name ?? ''}</span>
          </span>
        </button>

        {menu.open && (
          <div
            className={s.menu}
            role="menu"
            style={{ bottom: 'calc(100% + var(--s-2))', top: 'auto', left: 0 }}
          >
            <div className={s.menuLabel}>Signed in as</div>
            <div className={s.menuItem} style={{ cursor: 'default' }}>
              <span className={s.menuItemText}>
                <span className={s.menuItemName}>{user?.email}</span>
                <span className={s.menuItemMeta}>{tenant?.company_name}</span>
              </span>
            </div>
            <div className={s.menuDivider} />
            <button
              type="button"
              role="menuitem"
              className={s.menuItem}
              onClick={() => {
                menu.close();
                navigate('/app/settings');
              }}
            >
              <Icon name="settings" size={15} />
              Account settings
            </button>
            <button
              type="button"
              role="menuitem"
              className={s.menuItem}
              onClick={() => {
                signOut();
                navigate('/', { replace: true });
              }}
            >
              <Icon name="logout" size={15} />
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Project switcher
   ═══════════════════════════════════════════════════════════════════════ */

function ProjectSwitcher() {
  const { projects, project, selectProject } = useSession();
  const navigate = useNavigate();
  const menu = useDropdown<HTMLDivElement>();

  if (projects.length === 0) {
    return (
      <Button size="sm" variant="secondary" icon="plus" onClick={() => navigate('/app/projects/new')}>
        Create a project
      </Button>
    );
  }

  return (
    <div className={s.switcher} ref={menu.containerRef}>
      <button
        type="button"
        ref={menu.triggerRef}
        className={s.switcherBtn}
        onClick={menu.toggle}
        aria-expanded={menu.open}
        aria-haspopup="menu"
        aria-label="Switch project"
      >
        <Icon name="projects" size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span className={s.switcherText}>
          <span className={s.switcherName}>{project?.name ?? 'Select a project'}</span>
          <span className={s.switcherMeta}>
            {project?.domain_name} · {project?.item_count ?? 0}{' '}
            {project?.entity_label ?? 'item'}
            {(project?.item_count ?? 0) === 1 ? '' : 's'}
          </span>
        </span>
        <Icon name="chevron-down" size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      </button>

      {menu.open && (
        <div className={s.menu} role="menu">
          <div className={s.menuLabel}>Projects</div>
          {projects.map((p) => (
            <button
              key={p.project_id}
              type="button"
              role="menuitem"
              className={cx(s.menuItem, p.project_id === project?.project_id && s.menuItemActive)}
              onClick={() => {
                selectProject(p.project_id);
                menu.close();
                // Selecting a project is a request to go there. Staying put
                // would silently change the scope of a page the user is on.
                navigate('/app/project');
              }}
            >
              <Icon
                name={p.project_id === project?.project_id ? 'check' : 'projects'}
                size={15}
                strokeWidth={p.project_id === project?.project_id ? 2.4 : 1.6}
              />
              <span className={s.menuItemText}>
                <span className={s.menuItemName}>{p.name}</span>
                <span className={s.menuItemMeta}>{p.domain_name}</span>
              </span>
              <ModeBadge mode={p.mode} />
            </button>
          ))}
          <div className={s.menuDivider} />
          <button
            type="button"
            role="menuitem"
            className={s.menuItem}
            onClick={() => {
              menu.close();
              navigate('/app/projects/new');
            }}
          >
            <Icon name="plus" size={15} />
            New project
          </button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Live status
   -----------------------------------------------------------------------
   Just the socket. The project's mode used to be shown beside it, but the
   pricing switch now sits immediately to the left and says "Pricing on" or
   "Pricing off" in words — a badge repeating it was noise.
   ═══════════════════════════════════════════════════════════════════════ */

function LiveStatus() {
  const { state } = useLive();
  const { project } = useSession();
  // With no project there is no socket to open, so the indicator could only
  // ever say "Offline" — an alarming word for an account that simply has not
  // created anything yet.
  if (!project) return null;
  return <LiveIndicator state={state} />;
}

/* ═══════════════════════════════════════════════════════════════════════
   Pending decisions
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * The bell.
 *
 * It surfaces APPROVALS — questions the platform is waiting on a human to
 * answer — rather than generic notifications, because those are the only items
 * that actually block something. Clicking one goes to the alert that raised it.
 */
function PendingBell() {
  const navigate = useNavigate();
  const menu = useDropdown<HTMLDivElement>();

  // One shared fetch for the whole app; see hooks/useApprovals.tsx.
  const { approvals: items, count } = useApprovals();

  return (
    <div className={s.bellWrap} ref={menu.containerRef}>
      <button
        type="button"
        ref={menu.triggerRef}
        className={s.collapseBtn}
        onClick={menu.toggle}
        aria-expanded={menu.open}
        aria-haspopup="menu"
        aria-label={
          items.length > 0
            ? `${items.length} decisions waiting for you`
            : 'No decisions waiting'
        }
      >
        <Icon name="bell" size={16} />
        {items.length > 0 && <span className={s.bellDot} aria-hidden="true" />}
      </button>

      {menu.open && (
        <div className={s.notifList} role="menu">
          <div className={s.menuLabel}>Waiting on you</div>
          {items.length === 0 ? (
            <div className={s.notifEmpty}>
              Nothing needs a decision right now.
              <br />
              You will see questions here when pricing needs a human call.
            </div>
          ) : (
            items.map((a) => (
              <button
                key={a.approval_id}
                type="button"
                role="menuitem"
                className={s.notifItem}
                onClick={() => {
                  menu.close();
                  navigate('/app/alerts');
                }}
              >
                <div className={s.notifTop}>
                  <span className={s.notifTitle}>{a.question}</span>
                  <span className={s.notifTime}>{relativeTime(a.created_at)}</span>
                </div>
                <div className={s.notifBody}>
                  {a.context_summary || `${a.options?.length ?? 0} options to choose from`}
                </div>
              </button>
            ))
          )}
          {items.length > 0 && (
            <>
              <div className={s.menuDivider} />
              <button
                type="button"
                role="menuitem"
                className={s.menuItem}
                onClick={() => {
                  menu.close();
                  navigate('/app/alerts');
                }}
              >
                <Icon name="arrow-right" size={15} />
                Review all
                <Badge tone="critical">{count}</Badge>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
