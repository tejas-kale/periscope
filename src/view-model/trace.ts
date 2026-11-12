import type { EventRow } from '../core/types.ts';
import {
  buildTree,
  findMatches,
  flatten,
  mergeEvents,
  treeOrder,
  visibleId,
  type Row,
  type ShowFilter,
  type Tree,
  type TreeNode,
} from './tree.ts';
import type { KeyInputLike } from './session-list.ts';

export interface TraceFindState {
  open: boolean;
  query: string;
  matchIds: string[];
  matchSet: Set<string>;
  totalHits: number;
  matchIdx: number;
}

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
  find: TraceFindState;
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
  | { type: 'openFind' }
  | { type: 'setFindQuery'; query: string }
  | { type: 'nextMatch' }
  | { type: 'prevMatch' }
  | { type: 'closeFind' };

function emptyFindState(open = false): TraceFindState {
  return {
    open,
    query: '',
    matchIds: [],
    matchSet: new Set(),
    totalHits: 0,
    matchIdx: 0,
  };
}

function computeMatchesForTree(
  events: EventRow[],
  tree: Tree,
  query: string,
): { matchIds: string[]; totalHits: number } {
  const m = findMatches(events, query);
  if (!m.ids.length) return { matchIds: [], totalHits: 0 };
  const matchIds = [...new Set(treeOrder(tree, m.ids).map((id) => visibleId(tree, id)))];
  return { matchIds, totalHits: m.count };
}

function rebuildRows(
  tree: Tree,
  show: ShowFilter,
  expanded: Map<string, boolean>,
  collapseAll: boolean,
  selectedId: string | null,
  extraReveal: readonly string[] = [],
): { rows: Row[]; rowIndex: Map<string, number> } {
  const sel = selectedId ? visibleId(tree, selectedId) : null;
  const reveal = sel ? [...extraReveal, sel] : extraReveal;
  const rows = flatten(tree, {
    show,
    expanded,
    collapseAll,
    reveal: reveal.length ? reveal : undefined,
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
    find: emptyFindState(false),
  };
}

/** Merge newly arrived events into the trace without disturbing selection or scrollOffset. */
export function appendTraceEvents(state: TraceState, fresh: EventRow[]): TraceState {
  if (!fresh.length) return state;
  const events = mergeEvents(state.events, fresh);
  const tree = buildTree(events);
  let find = state.find;
  if (find.open && find.query.trim()) {
    const computed = computeMatchesForTree(events, tree, find.query);
    const { rows: preRows, rowIndex: preIndex } = rebuildRows(
      tree,
      state.show,
      state.expanded,
      state.collapseAll,
      state.selectedId,
      computed.matchIds,
    );
    const visibleMatches = computed.matchIds.filter((id) => preIndex.has(id));
    const matchIdx = visibleMatches.length
      ? Math.min(find.matchIdx, visibleMatches.length - 1)
      : 0;
    find = {
      ...find,
      matchIds: visibleMatches,
      matchSet: new Set(visibleMatches),
      totalHits: computed.totalHits,
      matchIdx,
    };
    const selectedId =
      state.selectedId && preIndex.has(visibleId(tree, state.selectedId))
        ? visibleId(tree, state.selectedId)
        : preRows.length > 0
          ? preRows[0]!.node.ev.id
          : null;
    const maxScroll = Math.max(0, preRows.length - 1);
    return {
      ...state,
      events,
      tree,
      rows: preRows,
      rowIndex: preIndex,
      selectedId,
      scrollOffset: Math.min(state.scrollOffset, maxScroll),
      find,
    };
  }
  const { rows, rowIndex } = rebuildRows(
    tree,
    state.show,
    state.expanded,
    state.collapseAll,
    state.selectedId,
  );
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

    case 'scrollBy': {
      const maxScroll = Math.max(0, rows.length - vp);
      const nextScroll = Math.max(0, Math.min(maxScroll, state.scrollOffset + action.delta));
      return nextScroll === state.scrollOffset ? state : { ...state, scrollOffset: nextScroll };
    }

    case 'selectId': {
      const id = visibleId(state.tree, action.id);
      let nextRows = rows;
      let nextIndex = rowIndex;
      if (!nextIndex.has(id)) {
        const rebuilt = rebuildRows(
          state.tree,
          state.show,
          state.expanded,
          state.collapseAll,
          id,
          state.find.matchIds,
        );
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
      };
    }

    case 'openFind': {
      if (state.find.open) return state;
      return {
        ...state,
        find: emptyFindState(true),
      };
    }

    case 'setFindQuery': {
      const query = action.query;
      const computed = computeMatchesForTree(state.events, state.tree, query);
      const rebuilt = rebuildRows(
        state.tree,
        state.show,
        state.expanded,
        state.collapseAll,
        state.selectedId,
        computed.matchIds,
      );
      const visibleMatches = computed.matchIds.filter((id) => rebuilt.rowIndex.has(id));
      const matchSet = new Set(visibleMatches);
      let selectedId = state.selectedId;
      let scrollOffset = state.scrollOffset;
      if (visibleMatches.length > 0) {
        selectedId = visibleMatches[0]!;
        const idx = rebuilt.rowIndex.get(selectedId);
        if (idx != null) scrollOffset = clampScrollForIndex(idx, scrollOffset, vp);
      } else {
        const maxScroll = Math.max(0, rebuilt.rows.length - vp);
        scrollOffset = Math.min(scrollOffset, maxScroll);
      }
      return {
        ...state,
        rows: rebuilt.rows,
        rowIndex: rebuilt.rowIndex,
        selectedId,
        scrollOffset,
        find: {
          open: true,
          query,
          matchIds: visibleMatches,
          matchSet,
          totalHits: computed.totalHits,
          matchIdx: 0,
        },
      };
    }

    case 'nextMatch':
    case 'prevMatch': {
      if (!state.find.open || state.find.matchIds.length === 0) return state;
      const len = state.find.matchIds.length;
      const delta = action.type === 'nextMatch' ? 1 : -1;
      const nextIdx = (state.find.matchIdx + delta + len) % len;
      const targetId = state.find.matchIds[nextIdx]!;
      const idx = rowIndex.get(targetId);
      const scrollOffset = idx != null ? clampScrollForIndex(idx, state.scrollOffset, vp) : state.scrollOffset;
      return {
        ...state,
        selectedId: targetId,
        scrollOffset,
        find: {
          ...state.find,
          matchIdx: nextIdx,
        },
      };
    }

    case 'closeFind': {
      if (!state.find.open && !state.find.query && state.find.matchIds.length === 0) return state;
      const rebuilt = rebuildRows(
        state.tree,
        state.show,
        state.expanded,
        state.collapseAll,
        state.selectedId,
      );
      const idx = state.selectedId ? rebuilt.rowIndex.get(state.selectedId) : undefined;
      const maxScroll = Math.max(0, rebuilt.rows.length - vp);
      const scrollOffset =
        idx != null ? clampScrollForIndex(idx, Math.min(state.scrollOffset, maxScroll), vp) : Math.min(state.scrollOffset, maxScroll);
      return {
        ...state,
        rows: rebuilt.rows,
        rowIndex: rebuilt.rowIndex,
        scrollOffset,
        find: emptyFindState(false),
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
      if (targetId === state.selectedId && scrollOffset === state.scrollOffset) return state;
      return { ...state, selectedId: targetId, scrollOffset };
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
          const nextId = rows[curIdx + 1]!.node.ev.id;
          return {
            ...state,
            selectedId: nextId,
            scrollOffset: clampScrollForIndex(curIdx + 1, state.scrollOffset, vp),
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
  return null;
}
