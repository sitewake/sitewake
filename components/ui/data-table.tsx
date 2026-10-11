"use client";

import { t } from "@/lib/i18n";

import { useMemo, useState, type ReactNode } from "react";
import { Button } from "./button";
import { EmptyState, ErrorState, Spinner } from "./feedback";
import { activateOnKey } from "./behavior";

export type Column<T> = {
  id: string;
  header: ReactNode;
  /** Omit to make the column non-sortable (actions, free-form cells). */
  sortValue?: (row: T) => string | number;
  cell: (row: T) => ReactNode;
  width?: string;
};

/**
 * One table for every list in the console.
 *
 * Consolidates behaviour each view previously either re-implemented or skipped:
 * sorting (nothing had it), pagination (page size varied per view — 40 here, 20
 * there, unbounded elsewhere), the loading/empty/error triad, and keyboard
 * activation of rows.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowActivate,
  loading = false,
  error,
  empty,
  pageSize = 25,
  caption,
  toolbar,
  searchFilter,
}: {
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  onRowActivate?: (row: T) => void;
  loading?: boolean;
  error?: string;
  empty?: { title: string; text?: string };
  pageSize?: number;
  caption?: string;
  toolbar?: ReactNode;
  /** Enables the search box. Return true to keep a row for the given query. */
  searchFilter?: (row: T, query: string) => boolean;
}) {
  const [sort, setSort] = useState<{ column: string; direction: "asc" | "desc" } | undefined>();
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const copy = t();

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term || !searchFilter) return rows;
    return rows.filter((row) => searchFilter(row, term));
  }, [rows, query, searchFilter]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const column = columns.find((item) => item.id === sort.column);
    if (!column?.sortValue) return filtered;
    const read = column.sortValue;
    // Copy first: sorting the incoming array in place would mutate the caller's state.
    return [...filtered].sort((a, b) => {
      const left = read(a);
      const right = read(b);
      const order = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), "zh-CN");
      return sort.direction === "asc" ? order : -order;
    });
  }, [filtered, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const visible = sorted.slice(current * pageSize, current * pageSize + pageSize);

  function toggleSort(columnId: string) {
    setPage(0);
    setSort((previous) =>
      previous?.column === columnId
        ? { column: columnId, direction: previous.direction === "asc" ? "desc" : "asc" }
        : { column: columnId, direction: "asc" },
    );
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="sa-table-wrap">
      {(toolbar || searchFilter) && (
        <div className="sa-table__toolbar">
          {searchFilter && (
            <input
              type="search"
              className="sa-table__search"
              placeholder={copy.common.search}
              aria-label={copy.common.searchTable}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          )}
          {toolbar}
        </div>
      )}
      {!sorted.length ? (
        <EmptyState
          title={empty?.title || (query ? copy.common.emptyFiltered : copy.common.emptyDefault)}
          text={query ? copy.common.emptyFilteredHint : empty?.text}
        />
      ) : (
        <>
          <table className="sa-table">
            {caption && <caption className="sa-eyebrow">{caption}</caption>}
            <thead>
              <tr>
                {columns.map((column) => {
                  const active = sort?.column === column.id;
                  return (
                    <th
                      key={column.id}
                      scope="col"
                      style={column.width ? { width: column.width } : undefined}
                      aria-sort={active ? (sort!.direction === "asc" ? "ascending" : "descending") : undefined}
                    >
                      {column.sortValue ? (
                        <button type="button" className="sa-table__sort" onClick={() => toggleSort(column.id)}>
                          {column.header}
                          <span aria-hidden="true">{active ? (sort!.direction === "asc" ? "↑" : "↓") : "↕"}</span>
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={onRowActivate ? "is-activatable" : undefined}
                  // Rows are only focusable when they actually do something.
                  tabIndex={onRowActivate ? 0 : undefined}
                  role={onRowActivate ? "button" : undefined}
                  onClick={onRowActivate ? () => onRowActivate(row) : undefined}
                  onKeyDown={onRowActivate ? activateOnKey(() => onRowActivate(row)) : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.id}>{column.cell(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {pageCount > 1 && (
            <nav className="sa-table__pager" aria-label={copy.common.pager}>
              <Button size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
                {copy.common.previousPage}
              </Button>
              <span>
                {copy.common.pagination(current + 1, pageCount, sorted.length)}
              </span>
              <Button size="sm" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
                {copy.common.nextPage}
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
