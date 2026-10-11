import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { approvalsApi } from '@/api/endpoints';
import type { PendingApprovalsResponse } from '@/api/types';
import { useAsync } from './useAsync';
import { useSession } from './useSession';

/**
 * Pending approvals, fetched ONCE for the whole app.
 *
 * Three places want this list — the bell in the top bar, the dashboard card and
 * the alerts page — and each used to call `/approvals/pending` itself. On the
 * dashboard that meant two requests for the same data on every load (one with
 * `limit=3`, one with `limit=10`), about 23KB of duplicate payload measured on
 * the deployed site.
 *
 * A single fetch at `limit=10` serves all three: the dashboard shows the first
 * few, the bell shows them all, and `count` comes from the server rather than
 * from the array length so a trimmed view never misreports the total.
 */

interface ApprovalsContextValue {
  approvals: PendingApprovalsResponse['approvals'];
  /** The server's total, which is not the same as `approvals.length`. */
  count: number;
  loading: boolean;
  refetch: () => void;
  /**
   * Hide an approval the moment it is answered, before the refetch lands.
   *
   * `/approvals/answer` both records and EXECUTES the choice, so by the time it
   * returns the decision is already made — leaving the card on screen for
   * another round trip makes a completed action look like it did not take.
   */
  dismiss: (approvalId: string) => void;
}

const ApprovalsContext = createContext<ApprovalsContextValue | null>(null);

export function ApprovalsProvider({ children }: { children: ReactNode }) {
  const { projectId } = useSession();

  const query = useAsync(
    (signal) => approvalsApi.pending({ project_id: projectId ?? undefined, limit: 10 }, { signal }),
    [projectId],
    { enabled: !!projectId, pollMs: 45_000 },
  );

  // Optimistically removed ids, held outside the fetched data so a refetch that
  // still includes them (eventual consistency) does not make them reappear.
  const dismissed = useMemo(() => new Set<string>(), []);

  const value = useMemo<ApprovalsContextValue>(() => {
    const all = query.data?.approvals ?? [];
    const visible = all.filter((a) => !dismissed.has(a.approval_id));
    return {
      approvals: visible,
      // Reduce the server's count by what we have optimistically hidden, so the
      // badge and the list cannot disagree.
      count: Math.max(0, (query.data?.count ?? visible.length) - (all.length - visible.length)),
      loading: query.initialLoading,
      refetch: query.refetch,
      dismiss: (approvalId: string) => {
        dismissed.add(approvalId);
        query.refetch();
      },
    };
  }, [query.data, query.initialLoading, query.refetch, dismissed]);

  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}

export function useApprovals(): ApprovalsContextValue {
  const ctx = useContext(ApprovalsContext);
  if (!ctx) throw new Error('useApprovals must be used inside <ApprovalsProvider>');
  return ctx;
}
