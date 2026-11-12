import type { EventRow } from '../core/types.ts';
import {
  buildTree,
  flatten,
  mergeEvents,
  visibleId,
  type Row,
  type ShowFilter,
  type Tree,
  type TreeNode,
} from './tree.ts';
import type { KeyInputLike } from './session-list.ts';

export interface TraceState {
  events: EventRow[];
  tree: Tree;
  rows: Row[];
  rowIndex: Map<string, number>;
  selectedId: string | null;
  scrollOffset: number;
  show: ShowFilter;
  collapseAll: boolean;
  expanded: Map<string, boolean>;
  rawMode: boolean;
  outputExpanded: Map<string, boolean>;
  follow: boolean;
}

export type TraceAction =
  | { type: 'moveUp' }
  | { type: 'moveDown' }
  | { type: 'pageUp' }
  | { type: 'pageDown' }
  | { type: 'jumpTop' }
  | { type: 'jumpBottom' }
  | { type: 'expandOrDescend' }
  | { type: 'collapseOrAscend' }
  | { type: 'toggleExpand' }
  | { type: 'selectId'; id: string; scrollIntoView?: boolean }
  | { type: 'scrollBy'; delta: number }
  | { type: 'toggleRaw' }
  | { type: 'toggleOutputExpand'; id: string }
  | { type: 'toggleFollow' };

function rebuildRows(
  tree: Tree,
  show: ShowFilter,
  expanded: Map<string, boolean>,
  collapseAll: boolean,
  selectedId: string | null,
): { rows: Row[]; rowIndex: Map<string, number> } {
  const sel = selectedId ? visibleId(tree, selectedId) : null;
  const rows = flatten(tree, {
    show,
    expanded,
    collapseAll,
    reveal: sel ? [sel] : undefined,
  });
  const rowIndex = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    rowIndex.set(rows[i]!.node.ev.id, i);
  }
  return { rows, rowIndex };
}

/** Create initial trace-tree view-model state for a session's events. */
export function createTraceState(events: EventRow[], focusEventId?: string | null): TraceState {
  const tree = buildTree(events);
  const show: ShowFilter = 'all';
  const collapseAll = false;
  const expanded = new Map<string, boolean>();
  const initialSel = focusEventId ? visibleId(tree, focusEventId) : null;
  const { rows, rowIndex } = rebuildRows(tree, show, expanded, collapseAll, initialSel);
  const selectedId =
    initialSel && rowIndex.has(initialSel)
      ? initialSel
      : rows.length > 0
        ? rows[0]!.node.ev.id
        : null;
  const selIdx = selectedId ? (rowIndex.get(selectedId) ?? 0) : 0;

  return {
    events,
    tree,
    rows,
    rowIndex,
    selectedId,
    scrollOffset: Math.max(0, selIdx),
    show,
    collapseAll,
    expanded,
    rawMode: false,
    outputExpanded: new Map(),
    follow: false,
  };
}

/** Merge newly arrived events into the trace; when follow is on, select and scroll to the newest row. */
export function appendTraceEvents(
  state: TraceState,
  fresh: EventRow[],
  viewportHeight = 20,
): TraceState {
  if (!fresh.length) return state;
  const events = mergeEvents(state.events, fresh);
  const tree = buildTree(events);
  const { rows, rowIndex } = rebuildRows(
    tree,
    state.show,
    state.expanded,
    state.collapseAll,
    state.follow ? null : state.selectedId,
  );
  if (state.follow && rows.length > 0) {
    const lastIdx = rows.length - 1;
    return {
      ...state,
      events,
      tree,
      rows,
      rowIndex,
      selectedId: rows[lastIdx]!.node.ev.id,
      scrollOffset: clampScrollForIndex(lastIdx, state.scrollOffset, Math.max(1, viewportHeight)),
    };
  }
  const selectedId =
    state.selectedId && rowIndex.has(visibleId(tree, state.selectedId))
      ? visibleId(tree, state.selectedId)
      : rows.length > 0
        ? rows[0]!.node.ev.id
        : null;
  const maxScroll = Math.max(0, rows.length - 1);
  return {
    ...state,
    events,
    tree,
    rows,
    rowIndex,
    selectedId,
    scrollOffset: Math.min(state.scrollOffset, maxScroll),
  };
}

/** Return the flattened visible rows for the current trace state. */
export function getVisibleRows(state: TraceState): Row[] {
  return state.rows;
}

/** Return the currently selected TreeNode, if any. */
export function getSelectedNode(state: TraceState): TreeNode | null {
  if (!state.selectedId) return null;
  return state.tree.byId.get(visibleId(state.tree, state.selectedId)) ?? null;
}

/** Compute the windowed slice of rows to render for a viewport height. */
export function computeWindow(
  rows: Row[],
  scrollOffset: number,
  viewportHeight: number,
  overscan = 4,
): { start: number; end: number; visibleRows: Row[] } {
  const vp = Math.max(1, viewportHeight);
  const maxStart = Math.max(0, rows.length - 1);
  const start = Math.max(0, Math.min(scrollOffset, maxStart));
  const end = Math.min(rows.length, start + vp + Math.max(0, overscan));
  return {
    start,
    end,
    visibleRows: rows.slice(start, end),
  };
}

function clampScrollForIndex(idx: number, scrollOffset: number, viewportHeight: number): number {
  const vp = Math.max(1, viewportHeight);
  if (idx < scrollOffset) return idx;
  if (idx >= scrollOffset + vp) return idx - vp + 1;
  return scrollOffset;
}

/** Apply a navigation, expand/collapse, or detail-toggle action to TraceState. */
export function applyTraceAction(
  state: TraceState,
  action: TraceAction,
  viewportHeight: number,
): TraceState {
  const vp = Math.max(1, viewportHeight);
  const { rows, rowIndex } = state;

  switch (action.type) {
    case 'toggleRaw':
      return { ...state, rawMode: !state.rawMode };

    case 'toggleOutputExpand': {
      const next = new Map(state.outputExpanded);
      next.set(action.id, !(next.get(action.id) ?? false));
      return { ...state, outputExpanded: next };
    }

    case 'toggleFollow': {
      if (state.follow) return { ...state, follow: false };
      if (!rows.length) return { ...state, follow: true };
      const lastIdx = rows.length - 1;
      return {
        ...state,
        follow: true,
        selectedId: rows[lastIdx]!.node.ev.id,
        scrollOffset: clampScrollForIndex(lastIdx, state.scrollOffset, vp),
      };
    }

    case 'scrollBy': {
      const maxScroll = Math.max(0, rows.length - vp);
      const nextScroll = Math.max(0, Math.min(maxScroll, state.scrollOffset + action.delta));
      const nextFollow = action.delta < 0 ? false : state.follow;
      if (nextScroll === state.scrollOffset && nextFollow === state.follow) return state;
      return { ...state, scrollOffset: nextScroll, follow: nextFollow };
    }

    case 'selectId': {
      const id = visibleId(state.tree, action.id);
      let nextRows = rows;
      let nextIndex = rowIndex;
      if (!nextIndex.has(id)) {
        const rebuilt = rebuildRows(state.tree, state.show, state.expanded, state.collapseAll, id);
        nextRows = rebuilt.rows;
        nextIndex = rebuilt.rowIndex;
      }
      const idx = nextIndex.get(id);
      if (idx == null) return state;
      const scrollOffset =
        action.scrollIntoView === false
          ? state.scrollOffset
          : clampScrollForIndex(idx, state.scrollOffset, vp);
      return {
        ...state,
        rows: nextRows,
        rowIndex: nextIndex,
        selectedId: id,
        scrollOffset,
        follow: nextRows.length > 0 && idx === nextRows.length - 1,
      };
    }

    case 'moveUp':
    case 'moveDown':
    case 'pageUp':
    case 'pageDown':
    case 'jumpTop':
    case 'jumpBottom': {
      if (!rows.length) return state;
      const curIdx = state.selectedId ? (rowIndex.get(state.selectedId) ?? 0) : 0;
      let targetIdx = curIdx;
      if (action.type === 'moveUp') targetIdx = Math.max(0, curIdx - 1);
      else if (action.type === 'moveDown') targetIdx = Math.min(rows.length - 1, curIdx + 1);
      else if (action.type === 'pageUp') targetIdx = Math.max(0, curIdx - Math.max(1, vp - 2));
      else if (action.type === 'pageDown') targetIdx = Math.min(rows.length - 1, curIdx + Math.max(1, vp - 2));
      else if (action.type === 'jumpTop') targetIdx = 0;
      else if (action.type === 'jumpBottom') targetIdx = rows.length - 1;

      const targetId = rows[targetIdx]!.node.ev.id;
      const scrollOffset = clampScrollForIndex(targetIdx, state.scrollOffset, vp);
      const nextFollow =
        action.type === 'moveUp' || action.type === 'pageUp' || action.type === 'jumpTop'
          ? false
          : targetIdx === rows.length - 1;
      if (targetId === state.selectedId && scrollOffset === state.scrollOffset && nextFollow === state.follow) {
        return state;
      }
      return { ...state, selectedId: targetId, scrollOffset, follow: nextFollow };
    }

    case 'toggleExpand':
    case 'expandOrDescend':
    case 'collapseOrAscend': {
      if (!rows.length || !state.selectedId) return state;
      const curIdx = rowIndex.get(state.selectedId);
      if (curIdx == null) return state;
      const row = rows[curIdx]!;

      if (action.type === 'toggleExpand') {
        if (!row.hasChildren) return state;
        const expanded = new Map(state.expanded);
        expanded.set(row.node.ev.id, !row.expanded);
        const rebuilt = rebuildRows(state.tree, state.show, expanded, state.collapseAll, state.selectedId);
        const idx = rebuilt.rowIndex.get(state.selectedId) ?? curIdx;
        return {
          ...state,
          expanded,
          rows: rebuilt.rows,
          rowIndex: rebuilt.rowIndex,
          scrollOffset: clampScrollForIndex(idx, state.scrollOffset, vp),
        };
      }

      if (action.type === 'expandOrDescend') {
        if (row.hasChildren && !row.expanded) {
          const expanded = new Map(state.expanded);
          expanded.set(row.node.ev.id, true);
          const rebuilt = rebuildRows(state.tree, state.show, expanded, state.collapseAll, state.selectedId);
          return { ...state, expanded, rows: rebuilt.rows, rowIndex: rebuilt.rowIndex };
        }
        if (row.hasChildren && row.expanded && curIdx + 1 < rows.length) {
          const nextIdx = curIdx + 1;
          const nextId = rows[nextIdx]!.node.ev.id;
          return {
            ...state,
            selectedId: nextId,
            scrollOffset: clampScrollForIndex(nextIdx, state.scrollOffset, vp),
            follow: nextIdx === rows.length - 1,
          };
        }
        return state;
      }

      // collapseOrAscend
      if (row.hasChildren && row.expanded) {
        const expanded = new Map(state.expanded);
        expanded.set(row.node.ev.id, false);
        const rebuilt = rebuildRows(state.tree, state.show, expanded, state.collapseAll, state.selectedId);
        const idx = rebuilt.rowIndex.get(state.selectedId) ?? curIdx;
        return {
          ...state,
          expanded,
          rows: rebuilt.rows,
          rowIndex: rebuilt.rowIndex,
          scrollOffset: clampScrollForIndex(idx, state.scrollOffset, vp),
        };
      }
      if (row.node.parent) {
        const parentId = visibleId(state.tree, row.node.parent.ev.id);
        const pIdx = rowIndex.get(parentId);
        if (pIdx != null) {
          return {
            ...state,
            selectedId: parentId,
            scrollOffset: clampScrollForIndex(pIdx, state.scrollOffset, vp),
            follow: false,
          };
        }
      }
      return state;
    }
  }
}

/** Map a key event in the trace pane to a TraceAction. */
export function keyToTraceAction(key: KeyInputLike): TraceAction | null {
  if (key.ctrl || key.meta) return null;
  const name = key.name;
  if (name === 'up' || name === 'k') return { type: 'moveUp' };
  if (name === 'down' || name === 'j') return { type: 'moveDown' };
  if (name === 'pageup') return { type: 'pageUp' };
  if (name === 'pagedown') return { type: 'pageDown' };
  if (name === 'g' && key.shift) return { type: 'jumpBottom' };
  if (name === 'g') return { type: 'jumpTop' };
  if (name === 'right' || name === 'l') return { type: 'expandOrDescend' };
  if (name === 'left' || name === 'h') return { type: 'collapseOrAscend' };
  if (name === 'space') return { type: 'toggleExpand' };
  if (name === 'r') return { type: 'toggleRaw' };
  if (name === 'f') return { type: 'toggleFollow' };
  return null;
}
