import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import s from './Table.module.css';

/**
 * A data table.
 *
 * Column-driven rather than children-driven: a column declares its own
 * alignment and renderer once, which is what keeps every numeric column
 * right-aligned and tabular without each page remembering to do it.
 *
 * Deliberately NOT virtualised. Every list endpoint is paginated server-side
 * with a sane limit, so these tables render tens of rows and not thousands —
 * virtualisation would add complexity and break Cmd-F for no gain.
 */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** `num` right-aligns and uses tabular figures. `mono` is for identifiers. */
  align?: 'left' | 'num' | 'right';
  mono?: boolean;
  muted?: boolean;
  nowrap?: boolean;
  truncate?: boolean;
  width?: string;
  render: (row: T) => ReactNode;
  /**
   * Makes the column sortable by returning the value to compare.
   *
   * Separate from `render` on purpose: the rendered cell is a ReactNode (often a
   * formatted string like "₹1,744.39" or a badge), and sorting on that would
   * order lexically — putting ₹9 above ₹10. This returns the raw value instead.
   */
  sortBy?: (row: T) => string | number | null | undefined;
  /** Sort descending on the first click. Right for dates and money. */
  sortDescFirst?: boolean;
}

export interface TableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Column key to sort by initially. */
  defaultSort?: string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  /** Keys of rows that just arrived, to animate their insertion. */
  freshKeys?: ReadonlySet<string>;
  caption?: string;
  footer?: ReactNode;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  defaultSort,
  onRowClick,
  selectedKey,
  freshKeys,
  caption,
  footer,
}: TableProps<T>) {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(() => {
    if (!defaultSort) return null;
    const col = columns.find((c) => c.key === defaultSort);
    return col ? { key: defaultSort, desc: col.sortDescFirst ?? false } : null;
  });

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortBy) return rows;
    const get = col.sortBy;
    // A copy, because `rows` belongs to the caller and sorting in place would
    // mutate their state.
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      // Missing values sort last in BOTH directions. An item with no cost is
      // not "cheapest" — it is unknown, and floating it to the top of an
      // ascending price sort would be actively misleading.
      if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
      if (bv === null || bv === undefined) return -1;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sort.desc ? -cmp : cmp;
    });
  }, [rows, sort, columns]);

  const toggleSort = (col: Column<T>) => {
    if (!col.sortBy) return;
    setSort((prev) =>
      prev?.key === col.key
        ? { key: col.key, desc: !prev.desc }
        : { key: col.key, desc: col.sortDescFirst ?? false },
    );
  };

  return (
    <>
      <div className={s.wrap}>
        <table className={[s.table, onRowClick ? s.clickable : ''].filter(Boolean).join(' ')}>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    className={cxTh(c, !!c.sortBy)}
                    style={c.width ? { width: c.width } : undefined}
                    scope="col"
                    aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}
                  >
                    {c.sortBy ? (
                      <button type="button" className={s.sortBtn} onClick={() => toggleSort(c)}>
                        {c.header}
                        <Icon
                          name={active ? (sort.desc ? 'arrow-down' : 'arrow-up') : 'chevron-down'}
                          size={11}
                          strokeWidth={2}
                          className={active ? s.sortOn : s.sortOff}
                        />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const key = rowKey(row);
              return (
                <tr
                  key={key}
                  className={[
                    selectedKey === key ? s.selected : '',
                    freshKeys?.has(key) ? s.streamIn : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  // A clickable row must be reachable and activatable by
                  // keyboard; without this the whole table is mouse-only.
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={[
                        c.align === 'num' || c.align === 'right' ? s.num : '',
                        c.mono ? s.mono : '',
                        c.muted ? s.muted : '',
                        c.nowrap ? s.nowrap : '',
                        c.truncate ? s.truncate : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer && <div className={s.footer}>{footer}</div>}
    </>
  );
}

/** Right-aligned actions inside a table footer. */
export function TableFooter({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <>
      <div>{left}</div>
      <div>{right}</div>
    </>
  );
}

/** Header cell classes. Kept out of the JSX so the markup stays readable. */
function cxTh<T>(c: Column<T>, sortable: boolean): string | undefined {
  const parts = [
    c.align === 'num' || c.align === 'right' ? s.num : '',
    sortable ? s.sortable : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}
