import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { DevNexusError, getToken, onSessionExpired, setToken } from '@/api/client';
import { authApi } from '@/api/endpoints';
import type { MeResponse } from '@/api/types';

/**
 * Who is signed in, which company they belong to, and which project they are
 * looking at.
 *
 * Everything comes from ONE call to `/auth/me`, which returns the user, the
 * tenant, every project and the full dropdown catalog together. That is why
 * there is a single provider rather than separate auth/project/catalog stores:
 * splitting them would mean three requests for data that arrives in one.
 *
 * The two-step signup is visible in the types. A session can legitimately exist
 * with `tenant === null` — the account is created but the company is not — and
 * in that state every endpoint except `/auth/complete-profile` returns 403. The
 * router reads `needsOnboarding` to send those users to step 2 instead of
 * letting them hit a wall of permission errors.
 */

export type Tenant = MeResponse['tenant'];
export type Project = MeResponse['projects'][number];
export type Catalog = MeResponse['catalog'];
export type User = MeResponse['user'];

type Status = 'loading' | 'authenticated' | 'anonymous';

interface SessionContextValue {
  status: Status;
  user: User | null;
  tenant: Tenant | null;
  catalog: Catalog | null;
  projects: Project[];

  /** True when step 1 is done but the company details are not. */
  needsOnboarding: boolean;

  /** The project every scoped screen reads. Null when the account has none. */
  project: Project | null;
  projectId: string | null;
  selectProject: (projectId: string) => void;

  /** Adopt a token returned by sign-in or sign-up, then bootstrap. */
  signIn: (token: string) => Promise<MeResponse | null>;
  signOut: () => void;
  /** Re-read `/auth/me`. Call after creating a project or completing a profile. */
  refresh: () => Promise<MeResponse | null>;

  error: DevNexusError | null;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Remembering the last project keeps a reload on the same workspace. */
const PROJECT_KEY = 'devnexus.project';
/** The cached `/auth/me` payload, so the shell can paint before the network. */
const ME_KEY = 'devnexus.me';

function readStoredProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

/**
 * The last `/auth/me` response, used to render immediately on a reload.
 *
 * `/auth/me` was measured at 316ms and it gates everything else — no project id
 * means no dashboard query can even start. Painting from cache first turns a
 * blank 300ms into an instant render, and the live response then replaces it.
 *
 * This is safe because the cache is NOT an authorisation decision: it only
 * supplies names, ids and dropdown options. Every actual request still carries
 * the token and is still checked by the server, so a stale cache cannot grant
 * access to anything — at worst it shows a project name that has since changed,
 * for the few hundred milliseconds before the real answer lands.
 *
 * It is keyed by token: switching accounts must never show the previous user's
 * company, and a signed-out token's cache is dropped rather than reused.
 */
function readCachedMe(token: string | null): MeResponse | null {
  if (!token) return null;
  try {
    const raw = localStorage.getItem(ME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string; me?: MeResponse };
    if (parsed.token !== token || !parsed.me) return null;
    return parsed.me;
  } catch {
    return null;
  }
}

function writeCachedMe(token: string | null, me: MeResponse | null): void {
  try {
    if (!token || !me) localStorage.removeItem(ME_KEY);
    else localStorage.setItem(ME_KEY, JSON.stringify({ token, me }));
  } catch {
    /* memory-only session; the network path still works */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  // Seed from cache so a reload renders the shell on the first frame instead of
  // showing a spinner for the duration of /auth/me. `authenticated` is claimed
  // up front because the cache is token-keyed — and if that token is actually
  // dead, the in-flight /auth/me returns 401 and signs the user out below.
  const [me, setMe] = useState<MeResponse | null>(() => readCachedMe(getToken()));
  const [status, setStatus] = useState<Status>(() => {
    if (!getToken()) return 'anonymous';
    return readCachedMe(getToken()) ? 'authenticated' : 'loading';
  });
  const [error, setError] = useState<DevNexusError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(readStoredProject);

  const load = useCallback(async (): Promise<MeResponse | null> => {
    const token = getToken();
    if (!token) {
      setStatus('anonymous');
      setMe(null);
      writeCachedMe(null, null);
      return null;
    }
    try {
      const result = await authApi.me();
      setMe(result);
      writeCachedMe(token, result);
      setError(null);
      setStatus('authenticated');
      return result;
    } catch (err) {
      const e = err instanceof DevNexusError ? err : null;
      // A 401 means the token is dead; the client has already cleared it.
      // Anything else — a network blip, a 5xx — must NOT sign the user out,
      // or a flaky connection would log people out mid-session.
      if (e?.status === 401) {
        setStatus('anonymous');
        setMe(null);
        // Drop the cache too, or the next reload would optimistically render a
        // shell for a session the server has already rejected.
        writeCachedMe(null, null);
      } else {
        setError(e);
        setStatus(getToken() ? 'authenticated' : 'anonymous');
      }
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The API client reports a 401 from anywhere in the app, so a revoked token
  // takes effect on whatever screen the user is on, not just on bootstrap.
  useEffect(
    () =>
      onSessionExpired(() => {
        setMe(null);
        setStatus('anonymous');
        writeCachedMe(null, null);
      }),
    [],
  );

  const signIn = useCallback(
    async (token: string) => {
      setToken(token);
      setStatus('loading');
      return load();
    },
    [load],
  );

  const signOut = useCallback(() => {
    setToken(null);
    setMe(null);
    setSelectedId(null);
    setStatus('anonymous');
    writeCachedMe(null, null);
    try {
      localStorage.removeItem(PROJECT_KEY);
    } catch {
      /* nothing to clear */
    }
  }, []);

  const projects = useMemo(() => me?.projects ?? [], [me]);

  /**
   * Resolve the active project.
   *
   * The stored id is validated against the list rather than trusted: it may
   * belong to an account that has since signed out on this machine, or to a
   * project that was removed. Falling back to the first project is right, and
   * silently rendering a dashboard for a project that no longer exists is not.
   */
  const project = useMemo(() => {
    if (projects.length === 0) return null;
    const found = selectedId ? projects.find((p) => p.project_id === selectedId) : undefined;
    return found ?? projects[0] ?? null;
  }, [projects, selectedId]);

  // Keep the stored id in step with what is actually displayed.
  useEffect(() => {
    if (!project) return;
    if (project.project_id === selectedId) return;
    setSelectedId(project.project_id);
  }, [project, selectedId]);

  const selectProject = useCallback((projectId: string) => {
    setSelectedId(projectId);
    try {
      localStorage.setItem(PROJECT_KEY, projectId);
    } catch {
      /* selection still applies for this session */
    }
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      user: me?.user ?? null,
      tenant: me?.tenant ?? null,
      catalog: me?.catalog ?? null,
      projects,
      needsOnboarding: status === 'authenticated' && !!me && !me.registration_complete,
      project,
      projectId: project?.project_id ?? null,
      selectProject,
      signIn,
      signOut,
      refresh: load,
      error,
    }),
    [status, me, projects, project, selectProject, signIn, signOut, load, error],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/**
 * The active project id, for screens that cannot function without one.
 *
 * Throwing here is deliberate: every scoped screen is rendered behind a guard
 * that redirects when there is no project, so reaching this with none is a
 * routing bug worth surfacing loudly rather than a state to render around.
 */
export function useProjectId(): string {
  const { projectId } = useSession();
  if (!projectId) throw new Error('No project selected — this screen requires one.');
  return projectId;
}
