import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './hooks/useSession';
import { AppShell } from './layouts/AppShell';
import { Loading } from './components/ui/Feedback';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/auth/LoginPage';
import { SignupPage } from './pages/auth/SignupPage';
import { OnboardingPage } from './pages/auth/OnboardingPage';

/**
 * Routing and the access rules around it.
 *
 * The app is split at the route level so the landing page and auth screens do
 * not carry the dashboard's chart library: recharts is by far the largest
 * dependency here, and a visitor who never signs in should never download it.
 */

/**
 * Route chunk loaders, exported so the sidebar can PREFETCH them on hover.
 *
 * Without this, clicking a nav item downloads its chunk and only then renders —
 * a visible stall on every first visit to a page. Hovering is a reliable signal
 * of intent and gives the network a head start of a few hundred milliseconds,
 * which is usually the whole download.
 *
 * Keyed by the same path strings the sidebar uses, so a typo in one shows up as
 * a missing prefetch rather than a silent mismatch.
 */
export const ROUTE_LOADERS: Record<string, () => Promise<unknown>> = {
  '/app': () => import('./pages/app/DashboardPage'),
  '/app/project': () => import('./pages/app/OverviewPage'),
  '/app/projects/new': () => import('./pages/app/CreateProjectWizard'),
  '/app/analytics': () => import('./pages/app/AnalyticsPage'),
  '/app/strategies': () => import('./pages/app/StrategiesPage'),
  '/app/simulation': () => import('./pages/app/SimulationPage'),
  '/app/data': () => import('./pages/app/DataPage'),
  '/app/items': () => import('./pages/app/ItemsPage'),
  '/app/rules': () => import('./pages/app/RulesPage'),
  '/app/alerts': () => import('./pages/app/AlertsPage'),
  '/app/audit': () => import('./pages/app/AuditPage'),
  '/app/api': () => import('./pages/app/ApiPage'),
  '/app/settings': () => import('./pages/app/AccountSettingsPage'),
  '/app/project/settings': () => import('./pages/app/ProjectSettingsPage'),
  '/app/project/playground': () => import('./pages/app/PlaygroundPage'),
};

/** Prefetch a route's chunk. Safe to call repeatedly — the import is cached. */
export function prefetchRoute(path: string): void {
  // A failed prefetch must never surface: the real navigation will retry and
  // show a proper error if the chunk genuinely cannot load.
  void ROUTE_LOADERS[path]?.().catch(() => {});
}

const DashboardPage = lazy(() => import('./pages/app/DashboardPage'));
const ProjectDashboardPage = lazy(() => import('./pages/app/OverviewPage'));
const CreateProjectWizard = lazy(() => import('./pages/app/CreateProjectWizard'));
const AnalyticsPage = lazy(() => import('./pages/app/AnalyticsPage'));
const StrategiesPage = lazy(() => import('./pages/app/StrategiesPage'));
const SimulationPage = lazy(() => import('./pages/app/SimulationPage'));
const DataPage = lazy(() => import('./pages/app/DataPage'));
const RulesPage = lazy(() => import('./pages/app/RulesPage'));
const AlertsPage = lazy(() => import('./pages/app/AlertsPage'));
const AuditPage = lazy(() => import('./pages/app/AuditPage'));
const ApiPage = lazy(() => import('./pages/app/ApiPage'));
const AccountSettingsPage = lazy(() => import('./pages/app/AccountSettingsPage'));
const ProjectSettingsPage = lazy(() => import('./pages/app/ProjectSettingsPage'));
const PlaygroundPage = lazy(() => import('./pages/app/PlaygroundPage'));
const ItemsPage = lazy(() => import('./pages/app/ItemsPage'));
const SchemaPage = lazy(() => import('./pages/app/SchemaPage'));

/**
 * A screen that requires a signed-in account with a company attached.
 *
 * Three states, three destinations:
 *
 *  - still bootstrapping  → a spinner, NOT a redirect. Redirecting while
 *    `/auth/me` is in flight would bounce a signed-in user to the login page on
 *    every hard refresh.
 *  - signed out           → login, remembering where they were headed
 *  - signed in, no company → onboarding, because every other endpoint 403s
 */
function Protected({ children }: { children: ReactNode }) {
  const { status, needsOnboarding } = useSession();
  const location = useLocation();

  if (status === 'loading') {
    return <FullPageLoading label="Loading your workspace" />;
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (needsOnboarding) {
    return <Navigate to="/onboarding" replace />;
  }
  return <>{children}</>;
}

/** Keeps a signed-in user off the landing and auth screens. */
function PublicOnly({ children }: { children: ReactNode }) {
  const { status, needsOnboarding } = useSession();
  if (status === 'loading') return <FullPageLoading label="Loading" />;
  if (status === 'authenticated') {
    return <Navigate to={needsOnboarding ? '/onboarding' : '/app'} replace />;
  }
  return <>{children}</>;
}

function FullPageLoading({ label }: { label: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <Loading label={label} />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      {/* ── public ──────────────────────────────────────────────────── */}
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/signup"
        element={
          <PublicOnly>
            <SignupPage />
          </PublicOnly>
        }
      />

      {/*
        Onboarding is its own case: the user IS authenticated but has no tenant,
        so it cannot sit behind Protected (which would redirect it to itself)
        nor behind PublicOnly (which would redirect it to the dashboard).
      */}
      <Route path="/onboarding" element={<OnboardingPage />} />

      {/* The wizard deliberately sits outside AppShell: it is a full-screen
          takeover, and rendering it inside would keep the chrome it exists to
          replace. */}
      <Route
        path="/app/projects/new"
        element={
          <Protected>
            <Suspense fallback={<Loading label="Opening the project wizard" />}>
              <CreateProjectWizard />
            </Suspense>
          </Protected>
        }
      />

      {/* ── application ─────────────────────────────────────────────── */}
      <Route
        path="/app"
        element={
          <Protected>
            <AppShell />
          </Protected>
        }
      >
        <Route
          index
          element={
            <Suspense fallback={<Loading label="Loading your workspace" />}>
              <DashboardPage />
            </Suspense>
          }
        />
        {APP_ROUTES.map(({ path, Component, label }) => (
          <Route
            key={path}
            path={path}
            element={
              <Suspense fallback={<Loading label={`Loading ${label}`} />}>
                <Component />
              </Suspense>
            }
          />
        ))}
      </Route>

      {/* Anything unrecognised goes home rather than to a dead end. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** The child routes of the shell, declared once. */
const APP_ROUTES = [
  { path: 'project', Component: ProjectDashboardPage, label: 'the dashboard' },
  { path: 'analytics', Component: AnalyticsPage, label: 'analytics' },
  { path: 'strategies', Component: StrategiesPage, label: 'strategies' },
  { path: 'simulation', Component: SimulationPage, label: 'simulation' },
  { path: 'data', Component: DataPage, label: 'data' },
  { path: 'items', Component: ItemsPage, label: 'items' },
  { path: 'rules', Component: RulesPage, label: 'rules' },
  { path: 'schema', Component: SchemaPage, label: 'the schema' },
  { path: 'alerts', Component: AlertsPage, label: 'alerts' },
  { path: 'audit', Component: AuditPage, label: 'the audit trail' },
  { path: 'api', Component: ApiPage, label: 'API integration' },
  // Two settings screens, one per scope: the account's preferences and the
  // open project's limits. See AccountSettingsPage for why they are apart.
  { path: 'settings', Component: AccountSettingsPage, label: 'account settings' },
  { path: 'project/settings', Component: ProjectSettingsPage, label: 'project settings' },
  { path: 'project/playground', Component: PlaygroundPage, label: 'the playground' },
] as const;
