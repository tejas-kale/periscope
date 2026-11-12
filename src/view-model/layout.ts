export type FocusPane = 'sessions' | 'trace' | 'detail';

export interface LayoutState {
  sessionsPct: number;
  tracePct: number;
  detailZoomed: boolean;
}

export interface PaneWidths {
  sessions: number;
  trace: number;
  detail: number;
}

export const DEFAULT_SESSIONS_PCT = 26;
export const DEFAULT_TRACE_PCT = 34;
const MIN_SESSIONS_PCT = 15;
const MIN_TRACE_PCT = 20;
const MIN_DETAIL_PCT = 20;

/** Create the default three-pane layout state. */
export function createLayoutState(): LayoutState {
  return {
    sessionsPct: DEFAULT_SESSIONS_PCT,
    tracePct: DEFAULT_TRACE_PCT,
    detailZoomed: false,
  };
}

/** Reset pane width percentages to defaults while preserving zoom state. */
export function resetPaneWidths(state: LayoutState): LayoutState {
  return {
    ...state,
    sessionsPct: DEFAULT_SESSIONS_PCT,
    tracePct: DEFAULT_TRACE_PCT,
  };
}

/** Toggle full-width detail pane zoom. */
export function toggleDetailZoom(state: LayoutState): LayoutState {
  return {
    ...state,
    detailZoomed: !state.detailZoomed,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Resize the focused pane by `deltaPct` percentage points, clamping all panes to usable minimums. */
export function resizePane(state: LayoutState, focus: FocusPane, deltaPct: number): LayoutState {
  if (deltaPct === 0) return state;

  let sessionsPct = state.sessionsPct;
  let tracePct = state.tracePct;

  if (focus === 'sessions') {
    const maxSessions = 100 - MIN_TRACE_PCT - MIN_DETAIL_PCT;
    const nextSessions = clamp(sessionsPct + deltaPct, MIN_SESSIONS_PCT, maxSessions);
    const maxTrace = 100 - nextSessions - MIN_DETAIL_PCT;
    tracePct = clamp(tracePct, MIN_TRACE_PCT, maxTrace);
    sessionsPct = nextSessions;
  } else if (focus === 'trace') {
    const maxTrace = 100 - MIN_SESSIONS_PCT - MIN_DETAIL_PCT;
    const nextTrace = clamp(tracePct + deltaPct, MIN_TRACE_PCT, maxTrace);
    const maxSessions = 100 - nextTrace - MIN_DETAIL_PCT;
    sessionsPct = clamp(sessionsPct, MIN_SESSIONS_PCT, maxSessions);
    tracePct = nextTrace;
  } else {
    // Adjusting detail pane changes the remaining (100 - sessionsPct - tracePct) share.
    const currentDetail = 100 - sessionsPct - tracePct;
    const maxDetail = 100 - MIN_SESSIONS_PCT - MIN_TRACE_PCT;
    const nextDetail = clamp(currentDetail + deltaPct, MIN_DETAIL_PCT, maxDetail);
    const appliedDelta = nextDetail - currentDetail;
    // Absorb from trace first, then sessions.
    const nextTrace = clamp(tracePct - appliedDelta, MIN_TRACE_PCT, 100 - MIN_SESSIONS_PCT - nextDetail);
    const remainingForSessions = 100 - nextDetail - nextTrace;
    sessionsPct = clamp(remainingForSessions, MIN_SESSIONS_PCT, 100 - nextDetail - MIN_TRACE_PCT);
    tracePct = 100 - nextDetail - sessionsPct;
  }

  return { ...state, sessionsPct, tracePct };
}

/** Compute integer column widths for the three panes given terminal width. */
export function computePaneWidths(
  terminalWidth: number,
  state: LayoutState,
  hasSession: boolean,
): PaneWidths {
  const total = Math.max(1, terminalWidth);
  if (!hasSession) {
    return { sessions: total, trace: 0, detail: 0 };
  }
  if (state.detailZoomed) {
    return { sessions: 0, trace: 0, detail: total };
  }
  const sessions = Math.max(1, Math.round((total * state.sessionsPct) / 100));
  const trace = Math.max(1, Math.round((total * state.tracePct) / 100));
  const detail = Math.max(1, total - sessions - trace);
  return { sessions, trace, detail };
}
