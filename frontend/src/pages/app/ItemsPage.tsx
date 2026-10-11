import { useState } from 'react';
import { itemsApi } from '@/api/endpoints';
import type { ItemListResponse } from '@/api/types';
import { KeyValues, MainWithSide, Note, PageHeader, Row, Stack } from '@/components/PageHeader';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox, Input, SearchInput } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading, SkeletonText } from '@/components/ui/Feedback';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { Table, type Column } from '@/components/ui/Table';
import { dateTime, duration, money, number, percent } from '@/lib/format';

/**
 * Items — the things being priced.
 *
 * Deliberately generic in its language: the project's own `entity_label` is used
 * throughout ("Room", "Product", "Desk"), because calling everything an "item"
 * is the small tell that a platform is not really domain-agnostic.
 *
 * Creating an item is a replace, not an insert — the backend's `/items/create`
 * overwrites by `item_id` — so the form says so rather than letting someone
 * believe they are adding a second one.
 */

type Item = ItemListResponse['items'][number];

export default function ItemsPage() {
  const { project, projectId } = useSession();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Ticked rows, for removing many at once — chiefly the sample data the
  // assistant adds, which the user clears out before going live.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  const list = useAsync(
    (signal) => itemsApi.list(projectId!, { search: search.trim() || undefined, limit: 50 }, { signal }),
    [projectId, search],
    { enabled: !!projectId },
  );

  const removeChecked = useMutation(
    async () => {
      const ids = [...checked];
      // Deletes are independent; run them together so clearing 10 sample rows
      // is one wait, not ten. A per-id failure is surfaced, the rest still go.
      const results = await Promise.allSettled(ids.map((id) => itemsApi.remove(projectId!, id)));
      const ok = ids.filter((_, i) => results[i]!.status === 'fulfilled');
      const failed = ids.length - ok.length;
      return { ok, failed };
    },
    {
      onSuccess: ({ ok, failed }) => {
        if (selected && ok.includes(selected)) setSelected(null);
        setChecked(new Set());
        setConfirmDelete(false);
        list.refetch();
        if (failed > 0) {
          toast.error(`Removed ${ok.length}, ${failed} failed`, 'Some rows could not be deleted — try again.');
        } else {
          toast.success(`Removed ${ok.length} ${ok.length === 1 ? 'row' : 'rows'}`, 'They are gone from pricing; past decisions are kept.');
        }
      },
      onError: (e) => toast.error('Could not delete', e.message),
    },
  );

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="projects"
          title="No project selected"
          body="Create a project before adding things to price."
          action={
            <LinkButton to="/app/projects/new" variant="primary" icon="plus">
              Create a project
            </LinkButton>
          }
        />
      </Card>
    );
  }

  const label = project.entity_label || 'Item';
  const plural = label.endsWith('s') ? label : `${label}s`;
  const items = list.data?.items ?? [];
  const currency = list.data?.currency ?? project.currency;

  const allChecked = items.length > 0 && items.every((i) => checked.has(i.item_id));
  const toggle = (id: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });

  const columns: readonly Column<Item>[] = [
    {
      key: 'pick',
      // Select-all for the rows in view. Lives in the header so "clear out the
      // samples" is one click, not fifty.
      header: (
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
          <Checkbox
            label={<span className="sr-only">Select all</span>}
            checked={allChecked}
            onChange={(e) =>
              setChecked(e.target.checked ? new Set(items.map((i) => i.item_id)) : new Set())
            }
          />
        </span>
      ),
      nowrap: true,
      // A click on the box must not also open the row's detail panel.
      render: (i) => (
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
          <Checkbox
            label={<span className="sr-only">Select {i.item_id}</span>}
            checked={checked.has(i.item_id)}
            onChange={(e) => toggle(i.item_id, e.target.checked)}
          />
        </span>
      ),
    },
    { key: 'id', header: 'ID', mono: true, nowrap: true, sortBy: (i) => i.item_id, render: (i) => i.item_id },
    { key: 'name', header: 'Name', sortBy: (i) => i.name, render: (i) => i.name },
    {
      key: 'base',
      header: 'Base price',
      align: 'num',
      sortBy: (i) => i.base_price,
      sortDescFirst: true,
      render: (i) => money(i.base_price, currency),
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'num',
      muted: true,
      // null sorts last in both directions: "no cost set" is unknown, not cheap.
      sortBy: (i) => i.cost,
      sortDescFirst: true,
      // No cost means margin guardrails cannot protect this item, which is
      // worth flagging rather than rendering as a blank cell.
      render: (i) =>
        i.cost === null ? <span style={{ color: 'var(--text-muted)' }}>not set</span> : money(i.cost, currency),
    },
    {
      key: 'margin',
      header: 'Margin',
      align: 'num',
      sortBy: (i) =>
        i.cost === null || i.cost === 0 ? null : ((i.base_price - i.cost) / i.base_price) * 100,
      sortDescFirst: true,
      render: (i) =>
        i.cost === null || i.cost === 0
          ? '—'
          : percent(((i.base_price - i.cost) / i.base_price) * 100),
    },
    // One column per item-scope field the schema declares (inventory, capacity…),
    // built from the list response so the table matches the project's own schema
    // rather than a fixed shape. Global and request fields never appear here.
    ...(list.data?.item_fields ?? []).map<Column<Item>>((f) => ({
      key: `sig_${f.id}`,
      header: f.label,
      align: f.type === 'number' ? ('num' as const) : undefined,
      sortBy: (i) => {
        const v = i.signals?.[f.id];
        return typeof v === 'number' ? v : (v ?? null);
      },
      render: (i) => {
        const v = i.signals?.[f.id];
        return v === undefined || v === '' ? (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        ) : (
          String(v)
        );
      },
    })),
    {
      key: 'updated',
      header: 'Updated',
      align: 'right',
      muted: true,
      nowrap: true,
      sortBy: (i) => i.updated_at,
      sortDescFirst: true,
      render: (i) => dateTime(i.updated_at),
    },
  ];

  return (
    <Stack>
      <PageHeader
        title={plural}
        description={`The ${plural.toLowerCase()} this project prices. Each one needs a base price; a cost lets DevNexus protect your margin. Add them one at a time, or import a CSV or JSON file.`}
        actions={
          <Row>
            <SearchInput value={search} onChange={setSearch} placeholder={`Search ${plural.toLowerCase()}`} />
            {/* Bulk import belongs beside "Add", not hidden on another screen:
                nobody types in a thousand SKUs one at a time, and the only
                moment they look for the file option is while they are here. */}
            <LinkButton to="/app/data?kind=items" size="sm" variant="secondary" icon="upload">
              Import a file
            </LinkButton>
            <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
              Add {label.toLowerCase()}
            </Button>
          </Row>
        }
      />

      {list.error && <ErrorState error={list.error} onRetry={list.refetch} />}

      <MainWithSide>
        <Card>
          <CardHeader
            title={plural}
            subtitle={items.length > 0 ? `${number(list.data?.count ?? items.length)} total` : undefined}
            actions={
              checked.size > 0 ? (
                <Row>
                  <span style={{ fontSize: 'var(--t-sm)', color: 'var(--text-muted)' }}>
                    {number(checked.size)} selected
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon="close"
                    loading={removeChecked.pending}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete {number(checked.size)}
                  </Button>
                </Row>
              ) : undefined
            }
          />
          {list.initialLoading ? (
            <Loading label={`Loading ${plural.toLowerCase()}`} />
          ) : items.length === 0 ? (
            <EmptyState
              icon="projects"
              title={search ? `No ${plural.toLowerCase()} match that search` : `No ${plural.toLowerCase()} yet`}
              body={
                search
                  ? 'Try a different search, or clear it to see everything.'
                  : `Add the first ${label.toLowerCase()} you want to price. You can also bulk-import them from a file.`
              }
              action={
                search ? (
                  <Button variant="secondary" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                ) : (
                  <Row>
                    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                      Add {label.toLowerCase()}
                    </Button>
                    <LinkButton to="/app/data?kind=items" variant="secondary" icon="upload">
                      Import from a file
                    </LinkButton>
                  </Row>
                )
              }
            />
          ) : (
            <Table
              caption={plural}
              columns={columns}
              rows={items}
              rowKey={(i) => i.item_id}
              defaultSort="updated"
              selectedKey={selected}
              onRowClick={(i) => setSelected(i.item_id)}
              footer={
                <>
                  <span>Showing {number(items.length)}</span>
                  <span>Select one to see its live context</span>
                </>
              }
            />
          )}
        </Card>

        {selected ? (
          <ItemDetail
            projectId={projectId!}
            itemId={selected}
            onClose={() => setSelected(null)}
          />
        ) : (
          <Card>
            <CardHeader title="Live context" />
            <CardBody>
              <Note>
                Select a {label.toLowerCase()} to see the signal values the engine currently holds
                for it, and the last price it returned.
              </Note>
            </CardBody>
          </Card>
        )}
      </MainWithSide>

      {creating && projectId && (
        <ItemForm
          projectId={projectId}
          label={label}
          currency={currency}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            list.refetch();
          }}
        />
      )}

      {confirmDelete && (
        <Modal
          open
          title={`Delete ${number(checked.size)} ${checked.size === 1 ? label.toLowerCase() : plural.toLowerCase()}?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <Row>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={removeChecked.pending}>
                Cancel
              </Button>
              <Button variant="danger" icon="close" loading={removeChecked.pending} onClick={() => void removeChecked.run()}>
                Delete {number(checked.size)}
              </Button>
            </Row>
          }
        >
          <Note>
            This removes {checked.size === 1 ? 'it' : 'them'} from pricing. Past decisions are kept,
            so old prices stay explainable. This cannot be undone.
          </Note>
        </Modal>
      )}
    </Stack>
  );
}

function ItemDetail({
  projectId,
  itemId,
  onClose,
}: {
  projectId: string;
  itemId: string;
  onClose: () => void;
}) {
  const detail = useAsync(
    (signal) => itemsApi.get(projectId, itemId, { signal }),
    [projectId, itemId],
    { pollMs: 20_000 },
  );

  const d = detail.data;

  return (
    <Stack>
      <Card>
        <CardHeader
          title={d?.item.name ?? itemId}
          subtitle={itemId}
          actions={<Button size="sm" variant="ghost" icon="close" aria-label="Close" onClick={onClose} />}
        />
        <CardBody>
          {detail.initialLoading ? (
            <SkeletonText lines={4} />
          ) : detail.error ? (
            <ErrorState error={detail.error} onRetry={detail.refetch} />
          ) : d ? (
            <KeyValues
              rows={[
                { key: 'Base price', value: money(d.item.base_price, d.currency) },
                { key: 'Cost', value: d.item.cost ? money(d.item.cost, d.currency) : 'not set' },
                {
                  key: 'Last price',
                  value: money(d.context.previous_price, d.currency),
                },
                { key: 'Context updated', value: dateTime(d.context.updated_at) },
              ]}
            />
          ) : null}
        </CardBody>
      </Card>

      {d && Object.keys(d.context.signals).length > 0 && (
        <Card>
          <CardHeader
            title="Current signals"
            subtitle="What the engine would evaluate if asked for a price right now."
          />
          <CardBody>
            <KeyValues
              rows={Object.entries(d.context.signals).map(([k, v]) => {
                const age = d.context.signal_age_seconds[k];
                return {
                  key: k,
                  value: (
                    <>
                      {typeof v === 'number' ? (Number.isInteger(v) ? number(v) : v.toFixed(2)) : String(v)}
                      {age !== undefined && (
                        <span
                          style={{
                            marginLeft: 'var(--s-2)',
                            fontSize: 'var(--t-xs)',
                            color: age > 60 ? 'var(--warning-text)' : 'var(--text-muted)',
                          }}
                        >
                          {duration(age)} old
                        </span>
                      )}
                    </>
                  ),
                };
              })}
            />
          </CardBody>
        </Card>
      )}

      {d && Object.keys(d.item.attributes ?? {}).length > 0 && (
        <Card>
          <CardHeader title="Attributes" />
          <CardBody>
            <KeyValues
              rows={Object.entries(d.item.attributes).map(([k, v]) => ({
                key: k,
                value: String(v),
              }))}
            />
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}

function ItemForm({
  projectId,
  label,
  currency,
  onClose,
  onSaved,
}: {
  projectId: string;
  label: string;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [itemId, setItemId] = useState('');
  const [name, setName] = useState('');
  const [basePrice, setBasePrice] = useState('');
  const [cost, setCost] = useState('');

  const save = useMutation(
    () =>
      itemsApi.create({
        project_id: projectId,
        item_id: itemId.trim(),
        name: name.trim(),
        base_price: Number(basePrice),
        cost: cost === '' ? undefined : Number(cost),
      }),
    {
      onSuccess: () => {
        toast.success(`${label} saved`);
        onSaved();
      },
    },
  );

  const valid = itemId.trim() && name.trim() && basePrice !== '' && !Number.isNaN(Number(basePrice));

  return (
    <Modal
      open
      onClose={onClose}
      title={`Add a ${label.toLowerCase()}`}
      subtitle={`Saving with an ID that already exists replaces that ${label.toLowerCase()}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.pending} disabled={!valid} onClick={() => void save.run()}>
            Save {label.toLowerCase()}
          </Button>
        </>
      }
    >
      <Stack>
        <Input
          label={`${label} ID`}
          autoFocus
          mono
          value={itemId}
          placeholder="R204"
          hint="Your own identifier. This is what your application sends to the pricing API."
          onChange={(e) => setItemId(e.target.value)}
        />
        <Input
          label="Name"
          value={name}
          placeholder="Deluxe double"
          onChange={(e) => setName(e.target.value)}
        />
        <Row>
          <Input
            label="Base price"
            type="number"
            step="0.01"
            prefix={currency}
            value={basePrice}
            hint="The starting point every rule adjusts from."
            onChange={(e) => setBasePrice(e.target.value)}
          />
          <Input
            label="Cost"
            type="number"
            step="0.01"
            optional
            prefix={currency}
            value={cost}
            hint="Needed for margin guardrails to work."
            onChange={(e) => setCost(e.target.value)}
          />
        </Row>

        {cost === '' && (
          <Note>
            Without a cost, a minimum-margin guardrail cannot protect this {label.toLowerCase()}.
            You can add it later.
          </Note>
        )}

        {save.error && <ErrorState error={save.error} title={`Could not save the ${label.toLowerCase()}`} />}
      </Stack>
    </Modal>
  );
}
