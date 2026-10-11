import { useState } from 'react';
import { CopyButton } from '@/components/ui/Code';
import { Icon, type IconName } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import s from './ApiDirectory.module.css';

/**
 * Every endpoint this project just gained, grouped by what it is for.
 *
 * A flat wall of URLs is the thing an integrator has to read three times. These
 * are grouped by job — price, context, catalogue — because that is how the work
 * actually divides: two endpoints belong in the hot path and the rest are
 * ordinary administration that happens once or on a schedule.
 *
 * The two runtime endpoints are authenticated by the PROJECT KEY and belong on
 * your server. The catalogue endpoints take a SESSION TOKEN and are the same
 * calls this dashboard makes, which is why they are marked differently: one
 * leaking is a pricing problem, the other is an account problem.
 */

export interface ApiEntry {
  name: string;
  path: string;
  /** What it is for, in one line. */
  purpose: string;
  /** Anything that will bite on the first integration. */
  note?: string;
  params?: string;
}

export interface ApiGroup {
  id: string;
  title: string;
  blurb: string;
  icon: IconName;
  auth: 'key' | 'token';
  entries: ApiEntry[];
  /** Hot-path groups are open on arrival; administration is not. */
  openByDefault?: boolean;
}

export function ApiDirectory({ groups, base }: { groups: readonly ApiGroup[]; base: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, !!g.openByDefault])),
  );

  return (
    <div className={s.wrap}>
      {groups.map((g) => {
        const isOpen = open[g.id] ?? false;
        return (
          <section key={g.id} className={cx(s.group, isOpen && s.groupOpen)}>
            <button
              type="button"
              className={s.groupHead}
              aria-expanded={isOpen}
              onClick={() => setOpen((p) => ({ ...p, [g.id]: !p[g.id] }))}
            >
              <span className={s.groupIcon}>
                <Icon name={g.icon} size={16} />
              </span>
              <span className={s.groupText}>
                <span className={s.groupTitle}>
                  {g.title}
                  <span className={s.count}>{g.entries.length}</span>
                </span>
                <span className={s.groupBlurb}>{g.blurb}</span>
              </span>
              <span className={cx(s.authTag, g.auth === 'key' ? s.authKey : s.authToken)}>
                {g.auth === 'key' ? 'project key' : 'session token'}
              </span>
              <Icon
                name="chevron-down"
                size={15}
                className={cx(s.chev, isOpen && s.chevOpen)}
              />
            </button>

            {isOpen && (
              <ul className={s.entries}>
                {g.entries.map((e) => (
                  <li key={e.path} className={s.entry}>
                    <div className={s.entryTop}>
                      <span className={s.method}>GET</span>
                      <span className={s.entryName}>{e.name}</span>
                      <CopyButton value={`${base}${e.path}`} label="" />
                    </div>
                    <code className={s.path}>
                      <span className={s.pathBase}>{base}</span>
                      {e.path}
                    </code>
                    <p className={s.purpose}>{e.purpose}</p>
                    {e.note && (
                      <p className={s.note}>
                        <Icon name="info" size={11} />
                        {e.note}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Every endpoint this project now answers, grouped by the job it does.
 *
 * The split is by CREDENTIAL as much as by purpose: the first two groups are
 * authenticated by the project key and belong on a server in the hot path; the
 * rest take a session token and are the same calls this dashboard makes. Mixing
 * them in one list is how a project key ends up in a browser.
 */
export function apiGroups(key: string, itemId: string, signalId: string): ApiGroup[] {
  return [
    {
      id: 'pricing',
      title: 'Get a price',
      blurb: 'The call your checkout, app or till makes',
      icon: 'api',
      auth: 'key',
      openByDefault: true,
      entries: [
        {
          name: 'Price one item',
          path: `/v1/p/${key}/price?item_id=${itemId}`,
          purpose: 'Returns the price to charge right now, with the reasoning attached.',
          note: 'Append any request-scope field as a parameter — e.g. &customer_tier=gold — and your rules can test it for this one call. It is never stored.',
        },
        {
          name: 'Price many at once',
          path: `/v1/p/${key}/price/bulk?item_ids=${itemId},P1002,P1003`,
          purpose: 'One round trip for a whole basket or a listing page.',
        },
        {
          name: 'Price a cart',
          path: `/v1/p/${key}/price/cart?cart=%5B%7B%22item_id%22%3A%22${itemId}%22%2C%22quantity%22%3A2%7D%5D`,
          purpose: 'Prices the whole basket together, so rules can use cart value, line quantity and bundle size.',
          note: 'Exposes cart_subtotal, cart_units, cart_lines and line_quantity to your rules — for "spend X save Y", bulk and bundle pricing.',
        },
        {
          name: 'Explain a decision',
          path: `/v1/p/${key}/explain?decision_id=DEC-XXXXXXXX`,
          purpose: 'The customer-facing "why is it this price" answer for any decision already made.',
        },
      ],
    },
    {
      id: 'context',
      title: 'Send context',
      blurb: 'What moves the price',
      icon: 'live',
      auth: 'key',
      openByDefault: true,
      entries: [
        {
          name: 'Send one event',
          path: `/v1/t/${key}/event?item_id=${itemId}&event_type=view&event_id=evt_1&signal_${signalId}=92`,
          purpose: 'Feeds a signal to the engine. Any item-scope signal rides along as signal_<id>.',
          note: 'event_id is required and makes the call idempotent — these are GET requests, so proxies and clients will retry them.',
        },
        {
          name: 'Send a batch',
          path: `/v1/t/${key}/event/batch?payload=%5B%7B...%7D%5D`,
          purpose: 'Up to a few hundred events in one call, as URL-encoded JSON.',
        },
        {
          name: 'Set overall conditions',
          path: `/v1/g/${key}/context?signal_website_traffic=45000`,
          purpose: 'Updates a GLOBAL signal once for the whole project — every item sees it on the next price request.',
          note: 'Only fields you declared with scope "overall" are accepted here. One write, not one per product.',
        },
      ],
    },
    {
      id: 'catalogue',
      title: 'Manage your products',
      blurb: 'Add, change and remove what you price',
      icon: 'projects',
      auth: 'token',
      entries: [
        {
          name: 'Add a product',
          path: `/items/create?token=…&project_id=…&item_id=P1005&name=New&base_price=250&cost=100&signals=%7B%22inventory%22%3A20%7D`,
          purpose: 'Adds one product, with the starting values of its item-scope signals.',
          note: 'Refuses a duplicate id with 409 unless you pass overwrite=true.',
        },
        {
          name: 'Update a product',
          path: `/items/update?token=…&project_id=…&item_id=P1005&base_price=275&signals=%7B%22inventory%22%3A8%7D`,
          purpose: 'Changes price, cost, name or any item-scope signal value.',
          note: 'The id itself can never change — it is what every past decision is filed under.',
        },
        {
          name: 'Delete a product',
          path: `/items/delete?token=…&project_id=…&item_id=P1005`,
          purpose: 'Removes it from pricing.',
          note: 'Past decisions are kept, so old prices stay explainable after the product is gone.',
        },
        {
          name: 'Bulk import',
          path: `/data/upload-url?token=…&project_id=…&filename=catalogue.csv&kind=items`,
          purpose: 'Returns a presigned URL; PUT your CSV, TSV, JSON or XLSX straight to it.',
          note: 'Rows are validated one by one — the ones that fail are reported with a reason, the rest still load.',
        },
      ],
    },
  ];
}
