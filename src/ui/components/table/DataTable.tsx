/**
 * ──────────────────────────────────────────────────────────────────────
 * A sortable, filterable table — because a curator's profile is 1,900 mods.
 *
 * Every list on the curator page was a flat stack of rows: no sort, no
 * search, and in the updates list a silent `slice(0, 40)`. On a real profile
 * that is unreadable, and the truncation was worse than unreadable — the
 * heading said 212 and the list showed 40 with nothing admitting it.
 *
 * The decisions live in `tableView.ts` and are tested without a DOM. This is
 * the rendering, and the two things it is careful about are:
 *
 * ─── SELECT ALL MEANS ALL THAT MATCHED ─────────────────────────────────
 * Not the whole profile, and not the visible slice. A curator filters to
 * narrow down and then ticks the result; selecting the 100 rows that fit on
 * screen out of 340 matches would be a silent partial act, and selecting all
 * 1,900 would be the opposite kind of surprise. The button says the number.
 *
 * ─── UNTICKING A FILTER DOES NOT UNTICK A ROW ──────────────────────────
 * Selection is held by the caller, keyed on mod id, and survives the filter
 * changing. A curator can search "SKSE", tick three, search "ENB", tick two,
 * and act on five. The header count is what says how many are really held,
 * because they are not all on screen.
 *
 * Keyboard: every column header is a real button (sortable with Enter and
 * Space, `aria-sort` announced), the filter boxes are labelled per column,
 * and the select-all box is indeterminate when only some matched rows are
 * ticked — so a partial selection never reads as "none".
 * ──────────────────────────────────────────────────────────────────────
 */

import * as React from "react";

import { Checkbox, Input, Select } from "../Field";
import { LinkButton } from "../LinkButton";
import {
  applyTableView,
  describeTableView,
  distinctValues,
  effectiveTarget,
  type CellValue,
  type ColumnSpec,
  type SortState,
  type TargetSet,
  type ViewRow,
} from "./tableView";

export type Column<T> = ColumnSpec & {
  /** The value that sorts and filters. Keep it plain — text or a number. */
  value: (row: T) => CellValue;
  /** Optional richer rendering. Falls back to the value itself. */
  render?: (row: T) => React.ReactNode;
};

/** One shared empty set, so an unselected table does not churn identities. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/** Click a header: ascending, then descending, then back to no sort. */
function nextSort(current: SortState | undefined, key: string): SortState | undefined {
  if (current === undefined || current.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return undefined;
}

/** A row's height before the first one has been measured. */
const ROW_HEIGHT_GUESS = 42;
/** Rows rendered beyond the visible band, so a scroll never shows a gap. */
const OVERSCAN = 12;

export function DataTable<T>(props: {
  rows: readonly T[];
  idOf: (row: T) => string;
  columns: readonly Column<T>[];
  /**
   * Unused since the table renders a window of rows over the whole list;
   * kept so callers need not change. The banner always says the real count.
   */
  limit?: number;
  /** What one row is called, for the banner. */
  noun?: string;
  /** Shown instead of the table when there is nothing at all. */
  empty?: React.ReactNode;
  /** Tick boxes. The set is the caller's; it survives filter changes. */
  selection?: {
    selected: ReadonlySet<string>;
    onChange: (next: ReadonlySet<string>) => void;
  };
  /** A trailing cell of buttons for one row. */
  actions?: (row: T) => React.ReactNode;
  /**
   * Width of the actions column. The table is fixed-layout, so a column
   * with no width shares the leftover space equally with every other
   * unsized column - which squeezes the name column to make room for two
   * small buttons. Set it when the actions have a known size.
   */
  actionsWidth?: number | string;
  /**
   * The table's minimum width. A fixed-layout table squeezed narrower than
   * the sum of its column widths gives the unsized name column nothing;
   * past this width the wrapper scrolls sideways instead.
   */
  minWidth?: number;
  maxHeight?: number;
  /**
   * What a button above this table should act on, whenever it changes.
   *
   * Ticks if any are set, otherwise everything the filters matched. Fires on
   * every change so the caller's button can carry the live count instead of
   * the total — "Update 126 mod(s)" over a table filtered to 80 is the bug
   * this exists to close.
   */
  onTarget?: (target: TargetSet) => void;
}): JSX.Element {
  const { rows, idOf, columns, selection, actions, actionsWidth } = props;
  const noun = props.noun ?? "item";

  const [filters, setFilters] = React.useState<Record<string, string>>({});
  const [sort, setSort] = React.useState<SortState | undefined>(undefined);
  /**
   * The rendered window. Every row is in the model (sort, filter, select-all
   * see all of them); only the rows near the scroll position exist in the
   * DOM. 1,900 mods × 8 cells × 2 buttons is not a DOM a page can carry.
   */
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewport, setViewport] = React.useState(props.maxHeight ?? 420);
  const [rowHeight, setRowHeight] = React.useState(ROW_HEIGHT_GUESS);
  const firstRowRef = React.useRef<HTMLTableRowElement>(null);
  React.useLayoutEffect(() => {
    const h = firstRowRef.current?.getBoundingClientRect().height;
    if (h !== undefined && h > 8 && Math.abs(h - rowHeight) > 0.5) setRowHeight(h);
    const v = wrapRef.current?.clientHeight;
    if (v !== undefined && v > 0 && v !== viewport) setViewport(v);
  });
  /**
   * The last row the curator clicked, for shift-click ranges.
   *
   * An id rather than an index: the index of a row changes under a sort or a
   * filter, so an anchor held as a number silently comes to mean a different
   * mod between two clicks.
   */
  const [anchor, setAnchor] = React.useState<string | undefined>(undefined);

  // Project once per change of the data, not once per keystroke of a filter.
  const { viewRows, byId } = React.useMemo(() => {
    const byId = new Map<string, T>();
    const viewRows: ViewRow[] = rows.map((row) => {
      const id = idOf(row);
      byId.set(id, row);
      const values: Record<string, CellValue> = {};
      for (const col of columns) values[col.key] = col.value(row);
      return { id, values };
    });
    return { viewRows, byId };
  }, [rows, idOf, columns]);

  const view = React.useMemo(
    () =>
      applyTableView({
        rows: viewRows,
        columns,
        filters,
        sort,
      }),
    [viewRows, columns, filters, sort],
  );

  // The window: OVERSCAN rows either side of what is visible.
  const total = view.rows.length;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
  const windowRows = view.rows.slice(start, end);
  const topSpace = start * rowHeight;
  const bottomSpace = Math.max(0, (total - end) * rowHeight);

  const matchedIds = React.useMemo(() => {
    // Everything the filter kept — including rows the cap left unrendered,
    // which is what "select all" has to mean for the number to be honest.
    const full = applyTableView({ rows: viewRows, columns, filters });
    return full.rows.map((r) => r.id);
  }, [viewRows, columns, filters]);

  const selectedMatched =
    selection === undefined
      ? 0
      : matchedIds.reduce((n, id) => n + (selection.selected.has(id) ? 1 : 0), 0);
  const allMatchedSelected =
    selection !== undefined && matchedIds.length > 0 && selectedMatched === matchedIds.length;
  const someMatchedSelected = selectedMatched > 0 && !allMatchedSelected;

  const filtersOn = Object.values(filters).some((v) => v.trim() !== "");

  const target = React.useMemo(
    () =>
      effectiveTarget({
        matched: matchedIds,
        total: rows.length,
        selected: selection?.selected ?? EMPTY,
      }),
    [matchedIds, rows.length, selection?.selected],
  );

  /**
   * Report the target upward, keyed on its CONTENT.
   *
   * A caller that passes an inline arrow gets a new function identity every
   * render; an effect depending on that identity would fire every render,
   * set the parent's state, and render again — forever. Depending on the ids
   * instead makes the callback's identity irrelevant, so no caller can loop
   * this by forgetting to memoize.
   */
  const targetKey = `${target.from}:${target.ids.join(",")}`;
  const onTargetRef = React.useRef(props.onTarget);
  onTargetRef.current = props.onTarget;
  React.useEffect(() => {
    onTargetRef.current?.(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  /**
   * What the header checkbox actually does, said in full.
   *
   * It ticks everything the filter matched — which is more than is on screen
   * whenever the cap is in play, and less than the profile whenever a filter
   * is. Both numbers matter, so the label names the one that applies rather
   * than saying "this filter matched" over a table with no filter on it.
   */
  const selectAllLabel = `${
    allMatchedSelected ? "Untick" : "Tick"
  } all ${matchedIds.length.toLocaleString()} ${noun}(s)${
    filtersOn ? " matching these filters" : " in this list"
  }`;

  if (rows.length === 0 && props.empty !== undefined) {
    return <>{props.empty}</>;
  }

  /**
   * One click on a row, with shift extending from the last one.
   *
   * The whole row is the target, not the six-pixel checkbox — picking forty
   * mods out of nineteen hundred through a tick box is the thing that was
   * "so hard". Shift applies the clicked row's NEW state across the range,
   * so a shift-click can clear a block as well as fill one.
   */
  const clickRow = (id: string, event: React.MouseEvent): void => {
    if (selection === undefined) return;
    // A click meant for a button, a filter box or a dropdown is not a
    // selection. Checkboxes are excluded from the exclusion: they ARE this.
    const el = event.target as HTMLElement;
    if (
      el.closest !== undefined &&
      el.closest('button, a, select, textarea, input:not([type="checkbox"])') !==
        null
    ) {
      return;
    }

    const willSelect = !selection.selected.has(id);
    const next = new Set(selection.selected);
    const order = view.rows.map((r) => r.id);
    const to = order.indexOf(id);
    const from = anchor === undefined ? -1 : order.indexOf(anchor);

    if (event.shiftKey && from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      for (let i = lo; i <= hi; i += 1) {
        const rowId = order[i]!;
        if (willSelect) next.add(rowId);
        else next.delete(rowId);
      }
    } else if (willSelect) {
      next.add(id);
    } else {
      next.delete(id);
    }

    setAnchor(id);
    selection.onChange(next);
  };

  const toggleAllMatched = (): void => {
    if (selection === undefined) return;
    const next = new Set(selection.selected);
    if (allMatchedSelected) for (const id of matchedIds) next.delete(id);
    else for (const id of matchedIds) next.add(id);
    selection.onChange(next);
  };

  const colCount =
    columns.length + (selection !== undefined ? 1 : 0) + (actions !== undefined ? 1 : 0);
  const anyFilterable = columns.some((c) => c.filterable !== false);

  return (
    <div>
      <div className="eh-table-toolbar">
        <span>{describeTableView(view, noun)}</span>
        {filtersOn && (
          <LinkButton variant="xs" onClick={(): void => setFilters({})}>
            Clear filters
          </LinkButton>
        )}

        {selection !== undefined &&
          (selection.selected.size > 0 ? (
            <>
              <span className="eh-muted">
                {selection.selected.size.toLocaleString()} ticked
                {filtersOn ? " (some may be outside this filter)" : ""}
              </span>
              <LinkButton variant="xs" onClick={(): void => selection.onChange(EMPTY)}>
                Clear ticks
              </LinkButton>
            </>
          ) : (
            <span className="eh-muted">Click a row to tick it · shift-click for a range</span>
          ))}
      </div>

      <div
        ref={wrapRef}
        className="eh-table-wrap"
        onScroll={(e): void => setScrollTop(e.currentTarget.scrollTop)}
        style={
          props.maxHeight !== undefined
            ? ({ ["--eh-table-max-height" as string]: `${props.maxHeight}px` } as React.CSSProperties)
            : undefined
        }
      >
        <table
          className={selection !== undefined ? "eh-table eh-table--selectable" : "eh-table"}
          style={
            props.minWidth !== undefined
              ? ({ ["--eh-table-min-width" as string]: `${props.minWidth}px` } as React.CSSProperties)
              : undefined
          }
        >
          <thead>
            <tr>
              {selection !== undefined && (
                <th className="eh-table__tick" scope="col">
                  <Checkbox
                    aria-label={selectAllLabel}
                    title={selectAllLabel}
                    checked={allMatchedSelected}
                    indeterminate={someMatchedSelected}
                    onChange={toggleAllMatched}
                  />
                </th>
              )}
              {columns.map((col) => {
                const sortable = col.sortable !== false;
                const active = sort?.key === col.key;
                const ariaSort = !active
                  ? sortable
                    ? "none"
                    : undefined
                  : sort!.direction === "asc"
                    ? "ascending"
                    : "descending";
                return (
                  <th
                    key={col.key}
                    scope="col"
                    className={col.align === "right" ? "eh-table__num" : undefined}
                    style={
                      col.width !== undefined
                        ? ({
                            ["--eh-col-width" as string]:
                              typeof col.width === "number" ? `${col.width}px` : col.width,
                          } as React.CSSProperties)
                        : undefined
                    }
                    aria-sort={ariaSort}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className={active ? "eh-table__sort eh-table__sort--active" : "eh-table__sort"}
                        onClick={(): void => setSort((s) => nextSort(s, col.key))}
                        title={`Sort by ${col.header}`}
                      >
                        <span>{col.header}</span>
                        <span className="eh-table__sort-glyph" aria-hidden="true">
                          {active ? (sort!.direction === "asc" ? "▲" : "▼") : "⇅"}
                        </span>
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
              {actions !== undefined && (
                <th
                  scope="col"
                  className="eh-table__actions"
                  style={
                    actionsWidth !== undefined
                      ? ({
                          ["--eh-col-width" as string]:
                            typeof actionsWidth === "number" ? `${actionsWidth}px` : actionsWidth,
                        } as React.CSSProperties)
                      : undefined
                  }
                />
              )}
            </tr>
            {anyFilterable && (
              <tr className="eh-table__filters">
                {selection !== undefined && <th />}
                {columns.map((col) => (
                  <th key={col.key}>
                    {col.filterable === false ? null : col.match === "exact" ? (
                      <Select
                        small
                        aria-label={`Filter by ${col.header}`}
                        value={filters[col.key] ?? ""}
                        onChange={(e): void =>
                          setFilters((f) => ({ ...f, [col.key]: e.target.value }))
                        }
                      >
                        <option value="">all</option>
                        {distinctValues(viewRows, col.key).map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        small
                        mono
                        aria-label={`Filter by ${col.header}`}
                        placeholder="filter"
                        value={filters[col.key] ?? ""}
                        onChange={(e): void =>
                          setFilters((f) => ({ ...f, [col.key]: e.target.value }))
                        }
                      />
                    )}
                  </th>
                ))}
                {actions !== undefined && <th />}
              </tr>
            )}
          </thead>
          <tbody>
            {view.rows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="eh-table__empty">
                  {`No ${noun} matches these filters.`}
                </td>
              </tr>
            )}
            {topSpace > 0 && (
              <tr className="eh-table__spacer" aria-hidden="true" style={{ ["--eh-spacer" as string]: `${topSpace}px` } as React.CSSProperties}>
                <td colSpan={colCount} />
              </tr>
            )}
            {windowRows.map((viewRow, i) => {
              const row = byId.get(viewRow.id)!;
              const selected = selection?.selected.has(viewRow.id) === true;
              return (
                <tr
                  key={viewRow.id}
                  ref={i === 0 ? firstRowRef : undefined}
                  className={selected ? "eh-table__row--selected" : undefined}
                  aria-selected={selection !== undefined ? selected : undefined}
                  onClick={
                    selection === undefined
                      ? undefined
                      : (e): void => clickRow(viewRow.id, e)
                  }
                >
                  {selection !== undefined && (
                    <td className="eh-table__tick">
                      <Checkbox
                        checked={selected}
                        aria-label={`Tick ${String(viewRow.values[columns[0]?.key ?? ""] ?? viewRow.id)}`}
                        // The row's own click handler does the work, including
                        // the shift-range case a change event cannot see.
                        onChange={(): void => undefined}
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={col.align === "right" ? "eh-table__num" : undefined}
                      title={
                        viewRow.values[col.key] === undefined
                          ? undefined
                          : String(viewRow.values[col.key])
                      }
                    >
                      {col.render !== undefined
                        ? col.render(row)
                        : (viewRow.values[col.key] ?? "—")}
                    </td>
                  ))}
                  {actions !== undefined && (
                    <td className="eh-table__actions">{actions(row)}</td>
                  )}
                </tr>
              );
            })}
            {bottomSpace > 0 && (
              <tr className="eh-table__spacer" aria-hidden="true" style={{ ["--eh-spacer" as string]: `${bottomSpace}px` } as React.CSSProperties}>
                <td colSpan={colCount} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
