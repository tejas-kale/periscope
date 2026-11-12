import {
  BoxRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type SyntaxStyle,
} from '@opentui/core';
import type { IndexProgress } from '../core/service.ts';
import type { ChangeNotice, EventRow, PeriscopeApi, SandboxState, SessionRow } from '../core/types.ts';
import type { ThemeOption } from '../cli/args.ts';
import {
  formatSandboxDetail,
  formatSandboxStatus,
} from '../view-model/sandbox-status.ts';
import {
  applySessionListAction,
  buildSessionListItems,
  createSessionListState,
  formatAge,
  formatAgent,
  formatHost,
  formatStatusBadge,
  keyToSessionListAction,
  type KeyInputLike,
  type SessionListItem,
  type SessionListState,
} from '../view-model/session-list.ts';
import {
  appendTraceEvents,
  applyTraceAction,
  computeWindow,
  createTraceState,
  getSelectedNode,
  getVisibleRows,
  keyToTraceAction,
  type TraceAction,
  type TraceState,
} from '../view-model/trace.ts';
import { buildDetailModel, extractImageRefs } from '../view-model/detail.ts';
import { fmtDuration, fmtTokens, hint, type Row } from '../view-model/tree.ts';
import { detectCapabilities } from './adapter.ts';
import { buildHighlightedStyledText } from './highlight.ts';
import {
  createDetailSyntaxStyle,
  getDetailPalette,
  renderDetailContent,
  type LoadedImage,
} from './detail-pane.ts';

export interface PeriscopeAppService
  extends Pick<
    PeriscopeApi,
    'listSessions' | 'getEvents' | 'getRaw' | 'readImage' | 'sandboxStatus' | 'onChange' | 'onSandbox'
  > {
  onProgress?(cb: (p: IndexProgress) => void): () => void;
}

export interface PeriscopeAppOptions {
  service: PeriscopeAppService;
  theme: ThemeOption;
  clock?: () => number;
  initiallyIndexing?: boolean;
  onQuit: () => void;
  onSelectSession?: (session: SessionRow) => void;
}

export interface PeriscopeAppHandle {
  refresh(): Promise<void>;
  dispose(): void;
}

type FocusPane = 'sessions' | 'trace' | 'detail';

const REFETCH_WINDOW = 200;

interface Palette {
  headerBg: string;
  headerFg: string;
  groupFg: string;
  cursorBg: string;
  selectedBg: string;
  fg: string;
  mutedFg: string;
  liveFg: string;
  errorFg: string;
  borderFg: string;
  focusBorderFg: string;
  detailBg: string;
  footerBg: string;
  matchBg: string;
  matchFg: string;
  matchRowBg: string;
}

function getPalette(mode: 'dark' | 'light'): Palette {
  if (mode === 'light') {
    return {
      headerBg: '#e5e7eb',
      headerFg: '#111827',
      groupFg: '#1d4ed8',
      cursorBg: '#dbeafe',
      selectedBg: '#bfdbfe',
      fg: '#111827',
      mutedFg: '#6b7280',
      liveFg: '#15803d',
      errorFg: '#b91c1c',
      borderFg: '#d1d5db',
      focusBorderFg: '#2563eb',
      detailBg: '#fef2f2',
      footerBg: '#e5e7eb',
      matchBg: '#facc15',
      matchFg: '#111827',
      matchRowBg: '#fef9c3',
    };
  }
  return {
    headerBg: '#1f2937',
    headerFg: '#f9fafb',
    groupFg: '#93c5fd',
    cursorBg: '#374151',
    selectedBg: '#1e3a8a',
    fg: '#f3f4f6',
    mutedFg: '#9ca3af',
    liveFg: '#4ade80',
    errorFg: '#f87171',
    borderFg: '#374151',
    focusBorderFg: '#60a5fa',
    detailBg: '#2b1c1f',
    footerBg: '#1f2937',
    matchBg: '#facc15',
    matchFg: '#111827',
    matchRowBg: '#422006',
  };
}

function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 1) return text.slice(0, Math.max(0, maxLen));
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function formatSessionRowText(item: SessionListItem, now: number, maxWidth: number): string {
  if (item.kind === 'group') {
    const chevron = item.expanded ? '▾' : '▸';
    const more = item.expanded && item.hiddenCount > 0 ? ` (+${item.hiddenCount} more, m)` : '';
    return truncateText(`${chevron} ${item.project} (${item.totalCount})${more}`, maxWidth);
  }
  const s = item.session;
  const quick = item.quickIndex != null ? `[${item.quickIndex}] ` : '    ';
  const badge = formatStatusBadge(s.status);
  const badgePart = badge ? `${badge}  ` : '';
  const agent = formatAgent(s.agent);
  const host = formatHost(s.host);
  const age = formatAge(s.updated_at ?? s.started_at, now);
  const meta = [agent, host, age].filter(Boolean).join(' · ');
  const suffix = `  |  ${meta}`;
  const prefix = `  ${quick}${badgePart}`;
  const titleBudget = Math.max(8, maxWidth - prefix.length - suffix.length);
  const title = truncateText((s.title || s.id).replace(/\s+/g, ' ').trim(), titleBudget);
  return `${prefix}${title}${suffix}`;
}

const KIND_ICON: Record<EventRow['kind'], string> = {
  turn: '›',
  reasoning: '◌',
  text: '◆',
  tool_call: '⚙',
  tool_result: '↳',
  error: '✕',
  meta: '·',
};

function formatTraceRowText(row: Row, maxWidth: number): string {
  const ev = row.node.ev;
  const indent = '  '.repeat(row.depth);
  const twisty = row.hasChildren ? (row.expanded ? '▾ ' : '▸ ') : '  ';
  const icon = KIND_ICON[ev.kind] ?? '·';
  const tool = ev.kind === 'tool_call' && ev.tool_name ? `${ev.tool_name} ` : '';
  const dur = fmtDuration(row.node.duration);
  const tok = row.node.tokensOut > 0 ? fmtTokens(row.node.tokensIn + row.node.tokensOut) : '';
  const meta = [dur, tok].filter(Boolean).join(' ');
  const suffix = meta ? `  ${meta}` : '';
  const prefix = `${indent}${twisty}${icon} ${tool}`;
  const bodyBudget = Math.max(8, maxWidth - prefix.length - suffix.length);
  const body = truncateText(hint(ev), bodyBudget);
  return `${prefix}${body}${suffix}`;
}

function decodeBase64DataUrl(dataUrl: string): Buffer | undefined {
  const idx = dataUrl.indexOf(',');
  if (idx === -1) return undefined;
  return Buffer.from(dataUrl.slice(idx + 1), 'base64');
}

/** Mount the Periscope terminal UI (session list + windowed trace tree + detail pane). */
export function mountPeriscopeApp(renderer: CliRenderer, options: PeriscopeAppOptions): PeriscopeAppHandle {
  const support = detectCapabilities(renderer);
  const resolvedTheme: 'dark' | 'light' =
    options.theme === 'auto' ? (renderer.themeMode ?? 'dark') : options.theme;
  const palette = getPalette(resolvedTheme);
  const detailPalette = getDetailPalette(resolvedTheme);
  const syntaxStyle: SyntaxStyle = createDetailSyntaxStyle(renderer, resolvedTheme);
  const clock = options.clock ?? Date.now;

  let sessions: SessionRow[] = [];
  let listState: SessionListState = createSessionListState([]);
  let activeSessionId: string | null = null;
  let traceState: TraceState = createTraceState([]);
  let focus: FocusPane = 'sessions';
  let loadedImages: LoadedImage[] = [];
  let imageLoadGen = 0;

  let sandbox: SandboxState = { state: 'unknown' };
  let showSandboxDetail = false;
  let findInputFocused = false;
  let progress: IndexProgress = options.initiallyIndexing
    ? { indexed: 0, total: 0, done: false }
    : { indexed: 0, total: 0, done: true };
  let disposed = false;

  const root = new BoxRenderable(renderer, {
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  });

  const headerBar = new BoxRenderable(renderer, {
    height: 1,
    width: '100%',
    flexShrink: 0,
    backgroundColor: palette.headerBg,
    onMouseDown: () => {
      showSandboxDetail = !showSandboxDetail;
      renderSandboxDetail();
    },
  });
  const headerText = new TextRenderable(renderer, {
    content: '',
    fg: palette.headerFg,
  });
  headerBar.add(headerText);

  const sandboxDetailBox = new BoxRenderable(renderer, {
    flexDirection: 'column',
    height: 0,
    width: '100%',
    flexShrink: 0,
    backgroundColor: palette.detailBg,
  });

  const findBar = new BoxRenderable(renderer, {
    height: 0,
    width: '100%',
    flexShrink: 0,
    visible: false,
    backgroundColor: palette.headerBg,
  });
  const findBarText = new TextRenderable(renderer, {
    content: '',
    fg: palette.headerFg,
  });
  findBar.add(findBarText);

  const bodyRow = new BoxRenderable(renderer, {
    flexDirection: 'row',
    flexGrow: 1,
    width: '100%',
  });

  const sessionsPane = new BoxRenderable(renderer, {
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    onMouseDown: () => {
      if (focus !== 'sessions') {
        focus = 'sessions';
        renderHeader();
        updatePaneBorders();
      }
    },
  });

  const listScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: '100%',
    scrollY: true,
    scrollX: false,
  });
  sessionsPane.add(listScroll);

  const tracePane = new BoxRenderable(renderer, {
    flexDirection: 'column',
    width: 0,
    height: '100%',
    border: ['left'],
    borderColor: palette.borderFg,
    visible: false,
    onMouseDown: () => {
      if (focus !== 'trace') {
        focus = 'trace';
        renderHeader();
        updatePaneBorders();
      }
    },
    onMouseScroll: (e) => {
      if (e.scroll?.direction === 'up') dispatchTrace({ type: 'scrollBy', delta: -3 });
      else if (e.scroll?.direction === 'down') dispatchTrace({ type: 'scrollBy', delta: 3 });
    },
  });

  const detailPane = new BoxRenderable(renderer, {
    flexDirection: 'column',
    width: 0,
    height: '100%',
    border: ['left'],
    borderColor: palette.borderFg,
    visible: false,
    onMouseDown: () => {
      if (focus !== 'detail') {
        focus = 'detail';
        renderHeader();
        updatePaneBorders();
      }
    },
  });

  const detailScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: '100%',
    paddingLeft: 1,
    paddingRight: 1,
    scrollY: true,
    scrollX: false,
  });
  detailPane.add(detailScroll);

  bodyRow.add(sessionsPane);
  bodyRow.add(tracePane);
  bodyRow.add(detailPane);

  const footerBar = new BoxRenderable(renderer, {
    height: 1,
    width: '100%',
    flexShrink: 0,
    backgroundColor: palette.footerBg,
  });
  const footerText = new TextRenderable(renderer, {
    content: '',
    fg: palette.headerFg,
  });
  footerBar.add(footerText);

  root.add(headerBar);
  root.add(sandboxDetailBox);
  root.add(findBar);
  root.add(bodyRow);
  root.add(footerBar);
  renderer.root.add(root);

  let sessionRowNodes: BoxRenderable[] = [];
  let sandboxDetailNodes: TextRenderable[] = [];
  // Windowed trace tree nodes keyed by event ID
  const traceRowNodes = new Map<string, { box: BoxRenderable; text: TextRenderable }>();

  const clearSessionRows = () => {
    for (const node of sessionRowNodes) {
      listScroll.remove(node);
      node.destroyRecursively();
    }
    sessionRowNodes = [];
  };

  const clearTraceRows = () => {
    for (const entry of traceRowNodes.values()) {
      tracePane.remove(entry.box);
      entry.box.destroyRecursively();
    }
    traceRowNodes.clear();
  };

  const updatePaneBorders = () => {
    tracePane.borderColor = focus === 'trace' ? palette.focusBorderFg : palette.borderFg;
    detailPane.borderColor = focus === 'detail' ? palette.focusBorderFg : palette.borderFg;
  };

  const updatePaneVisibility = () => {
    const hasSession = activeSessionId !== null;
    if (hasSession) {
      sessionsPane.width = '26%';
      tracePane.width = '34%';
      tracePane.visible = true;
      detailPane.width = '40%';
      detailPane.visible = true;
    } else {
      sessionsPane.width = '100%';
      tracePane.width = 0;
      tracePane.visible = false;
      detailPane.width = 0;
      detailPane.visible = false;
    }
    updatePaneBorders();
  };

  const clearSandboxDetail = () => {
    for (const node of sandboxDetailNodes) {
      sandboxDetailBox.remove(node);
      node.destroyRecursively();
    }
    sandboxDetailNodes = [];
  };

  const renderSandboxDetail = () => {
    clearSandboxDetail();
    if (!showSandboxDetail) {
      sandboxDetailBox.height = 0;
      return;
    }
    const detail = formatSandboxDetail(sandbox);
    const maxW = Math.max(40, renderer.terminalWidth - 2);
    const titleNode = new TextRenderable(renderer, {
      content: truncateText(` ${detail.title}  (S / Esc to close)`, maxW),
      fg: sandbox.state === 'error' ? palette.errorFg : palette.headerFg,
    });
    const bodyNode = new TextRenderable(renderer, {
      content: truncateText(` ${detail.body.replace(/\s+/g, ' ').trim()}`, maxW),
      fg: palette.fg,
    });
    sandboxDetailBox.backgroundColor = sandbox.state === 'error' ? palette.detailBg : palette.headerBg;
    sandboxDetailBox.height = 2;
    sandboxDetailBox.add(titleNode);
    sandboxDetailBox.add(bodyNode);
    sandboxDetailNodes.push(titleNode, bodyNode);
  };

  const renderHeader = () => {
    const focusLabel = activeSessionId ? `  |  pane: ${focus} (Tab)` : '';
    headerText.content = ` Periscope  |  theme: ${resolvedTheme}  |  ${formatSandboxStatus(sandbox)}${focusLabel}  |  q quit`;
  };

  const renderFooter = () => {
    const selected = listState.selectedSessionId
      ? sessions.find((s) => s.id === listState.selectedSessionId)
      : undefined;
    if (selected) {
      footerText.content = ` Selected: ${selected.title || selected.id} (${formatAgent(selected.agent)}, ${formatHost(selected.host)})`;
    } else {
      footerText.content = ' Navigate: ↑/↓/j/k  Toggle: Space/←/→  Quick-open: 1-9  Open: Enter';
    }
  };

  const renderSessionsPane = () => {
    clearSessionRows();
    if (!progress.done) {
      const box = new BoxRenderable(renderer, { height: 1, width: '100%' });
      const label =
        progress.total > 0
          ? ` Indexing sessions... ${progress.indexed} / ${progress.total}`
          : ' Indexing sessions...';
      box.add(new TextRenderable(renderer, { content: label, fg: palette.fg }));
      listScroll.add(box);
      sessionRowNodes.push(box);
      return;
    }

    if (sessions.length === 0) {
      const box = new BoxRenderable(renderer, { height: 1, width: '100%' });
      box.add(new TextRenderable(renderer, { content: ' No sessions found.', fg: palette.mutedFg }));
      listScroll.add(box);
      sessionRowNodes.push(box);
      return;
    }

    const now = clock();
    const items = buildSessionListItems(sessions, listState);
    const paneWidth = activeSessionId
      ? Math.max(20, Math.floor(renderer.terminalWidth * 0.26) - 2)
      : Math.max(40, renderer.terminalWidth - 2);

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const isCursor = listState.cursorKey === item.key;
      const isSelected = item.kind === 'session' && listState.selectedSessionId === item.session.id;
      const bg = isSelected ? palette.selectedBg : isCursor ? palette.cursorBg : undefined;
      const fg =
        item.kind === 'group'
          ? palette.groupFg
          : item.session.status === 'live'
            ? palette.liveFg
            : palette.fg;

      const rowBox = new BoxRenderable(renderer, {
        height: 1,
        width: '100%',
        flexShrink: 0,
        backgroundColor: bg,
        onMouseDown: () => {
          focus = 'sessions';
          dispatchSessionList({ type: 'clickItem', key: item.key });
        },
      });
      const rowText = new TextRenderable(renderer, {
        content: formatSessionRowText(item, now, paneWidth),
        fg,
      });
      rowBox.add(rowText);
      listScroll.add(rowBox);
      sessionRowNodes.push(rowBox);
    }
  };

  const renderFindBar = () => {
    if (!activeSessionId || !traceState.find.open) {
      findBar.height = 0;
      findBar.visible = false;
      return;
    }
    findBar.height = 1;
    findBar.visible = true;
    const f = traceState.find;
    const countText = f.query.trim()
      ? f.matchIds.length > 0
        ? `${f.matchIdx + 1}/${f.matchIds.length}`
        : '0/0'
      : '';
    const cursor = findInputFocused ? '█' : '';
    const hints = findInputFocused ? 'Enter: step  Esc: close' : 'n/N: next/prev  /: edit  Esc: close';
    const maxW = Math.max(40, renderer.terminalWidth - 2);
    const line = ` Find: ${f.query}${cursor}${countText ? `  ${countText}` : ''}  [${hints}]`;
    findBarText.content = truncateText(line, maxW);
  };

  const traceViewportHeight = () =>
    Math.max(1, renderer.terminalHeight - 2 - (traceState.find.open ? 1 : 0));

  const renderTracePane = () => {
    if (!activeSessionId) {
      clearTraceRows();
      return;
    }
    const rows = getVisibleRows(traceState);
    const vpHeight = traceViewportHeight();
    const { visibleRows } = computeWindow(rows, traceState.scrollOffset, vpHeight, 4);
    const paneWidth = Math.max(24, Math.floor(renderer.terminalWidth * 0.34) - 2);

    const keepIds = new Set(visibleRows.map((r) => r.node.ev.id));
    for (const [id, entry] of traceRowNodes.entries()) {
      if (!keepIds.has(id)) {
        tracePane.remove(entry.box);
        entry.box.destroyRecursively();
        traceRowNodes.delete(id);
      }
    }

    const findQuery = traceState.find.open ? traceState.find.query.trim() : '';
    const matchBg = RGBA.fromHex(palette.matchBg);
    const matchFg = RGBA.fromHex(palette.matchFg);

    for (let i = 0; i < visibleRows.length; i++) {
      const row = visibleRows[i]!;
      const id = row.node.ev.id;
      const isSel = traceState.selectedId === id;
      const isMatch = traceState.find.open && traceState.find.matchSet.has(id);
      const isErr = row.node.ev.kind === 'error' || row.node.failed;
      const bg = isSel ? palette.selectedBg : isMatch ? palette.matchRowBg : undefined;
      const fg = isErr ? palette.errorFg : palette.fg;
      const label = formatTraceRowText(row, paneWidth);
      const content =
        findQuery && label.toLowerCase().includes(findQuery.toLowerCase())
          ? buildHighlightedStyledText(label, findQuery, RGBA.fromHex(fg), matchBg, matchFg)
          : label;

      let entry = traceRowNodes.get(id);
      if (!entry) {
        const box = new BoxRenderable(renderer, {
          height: 1,
          width: '100%',
          flexShrink: 0,
          backgroundColor: bg,
          onMouseDown: () => {
            focus = 'trace';
            dispatchTrace({ type: 'selectId', id, scrollIntoView: false });
          },
        });
        const text = new TextRenderable(renderer, { content, fg });
        box.add(text);
        tracePane.add(box, i);
        entry = { box, text };
        traceRowNodes.set(id, entry);
      } else {
        entry.box.backgroundColor = bg ?? 'transparent';
        entry.text.content = content;
        entry.text.fg = fg;
        if (tracePane.getChildren()[i] !== entry.box) {
          tracePane.add(entry.box, i);
        }
      }
    }
  };

  const renderDetailPane = () => {
    if (!activeSessionId) return;
    const node = getSelectedNode(traceState);
    const outputExpanded = node ? (traceState.outputExpanded.get(node.ev.id) ?? false) : false;
    const model = buildDetailModel(node, {
      rawMode: traceState.rawMode,
      outputExpanded,
    });
    renderDetailContent({
      renderer,
      scrollBox: detailScroll,
      model,
      images: loadedImages,
      supportsImages: support.images,
      palette: detailPalette,
      syntaxStyle,
      findQuery: traceState.find.open ? traceState.find.query : undefined,
      onToggleRaw: () => dispatchTrace({ type: 'toggleRaw' }),
      onToggleOutputExpand: () => {
        if (node) dispatchTrace({ type: 'toggleOutputExpand', id: node.ev.id });
      },
    });
  };

  const loadImagesForSelectedStep = async () => {
    const node = getSelectedNode(traceState);
    const gen = ++imageLoadGen;
    loadedImages = [];
    if (!node) return;
    const model = buildDetailModel(node, { rawMode: traceState.rawMode, outputExpanded: false });
    const found: LoadedImage[] = [];
    for (const id of model.imageEventIds) {
      try {
        const raw = await options.service.getRaw(id);
        if (disposed || gen !== imageLoadGen) return;
        const refs = extractImageRefs(raw);
        for (const ref of refs) {
          if (ref.kind === 'base64') {
            found.push({ ref, buffer: Buffer.from(ref.data, 'base64') });
          } else if (ref.kind === 'uri') {
            const dataUrl = await options.service.readImage(ref.uri);
            if (disposed || gen !== imageLoadGen) return;
            found.push({ ref, buffer: dataUrl ? decodeBase64DataUrl(dataUrl) : undefined });
          }
        }
      } catch {
        // Ignore raw/image read failures for individual steps
      }
    }
    if (disposed || gen !== imageLoadGen) return;
    if (found.length > 0) {
      loadedImages = found;
      renderDetailPane();
    }
  };

  const renderAll = () => {
    if (disposed) return;
    updatePaneVisibility();
    renderHeader();
    renderSandboxDetail();
    renderFindBar();
    renderSessionsPane();
    renderTracePane();
    renderDetailPane();
    renderFooter();
  };

  const openSession = async (session: SessionRow) => {
    activeSessionId = session.id;
    focus = 'trace';
    findInputFocused = false;
    loadedImages = [];
    traceState = createTraceState([]);
    renderAll();

    const events = await options.service.getEvents(session.id);
    if (disposed || activeSessionId !== session.id) return;
    traceState = createTraceState(events);
    renderAll();
    void loadImagesForSelectedStep();
  };

  const dispatchSessionList = (action: Parameters<typeof applySessionListAction>[2]) => {
    const prevSelected = listState.selectedSessionId;
    const nextState = applySessionListAction(listState, sessions, action);
    listState = nextState;

    const items = buildSessionListItems(sessions, listState);
    const cursorIdx = listState.cursorKey ? items.findIndex((it) => it.key === listState.cursorKey) : -1;
    if (cursorIdx >= 0) {
      const vpHeight = Math.max(1, listScroll.viewport.height || renderer.terminalHeight - 2);
      if (cursorIdx < listScroll.scrollTop) {
        listScroll.scrollTo(cursorIdx);
      } else if (cursorIdx >= listScroll.scrollTop + vpHeight) {
        listScroll.scrollTo(cursorIdx - vpHeight + 1);
      }
    }

    renderSessionsPane();
    renderFooter();

    if (
      nextState.selectedSessionId &&
      (nextState.selectedSessionId !== prevSelected ||
        action.type === 'activate' ||
        action.type === 'quickOpen' ||
        action.type === 'clickItem')
    ) {
      const selected = sessions.find((s) => s.id === nextState.selectedSessionId);
      if (selected) {
        options.onSelectSession?.(selected);
        void openSession(selected);
      }
    }
  };

  const dispatchTrace = (action: TraceAction) => {
    const prevSel = traceState.selectedId;
    const prevRaw = traceState.rawMode;
    const prevExp = prevSel ? traceState.outputExpanded.get(prevSel) : undefined;
    const prevFind = traceState.find;
    traceState = applyTraceAction(traceState, action, traceViewportHeight());
    renderFindBar();
    renderTracePane();

    const nextSel = traceState.selectedId;
    const nextExp = nextSel ? traceState.outputExpanded.get(nextSel) : undefined;
    const findChanged =
      traceState.find.open !== prevFind.open ||
      traceState.find.query !== prevFind.query ||
      traceState.find.matchIdx !== prevFind.matchIdx;
    if (nextSel !== prevSel || traceState.rawMode !== prevRaw || nextExp !== prevExp || findChanged) {
      if (nextSel !== prevSel) {
        loadedImages = [];
        void loadImagesForSelectedStep();
      }
      renderDetailPane();
    }
  };

  const refresh = async () => {
    if (disposed) return;
    const [nextSessions, nextSandbox] = await Promise.all([
      options.service.listSessions({}),
      options.service.sandboxStatus(),
    ]);
    if (disposed) return;
    sessions = nextSessions;
    sandbox = nextSandbox;
    if (!listState.cursorKey && sessions.length > 0) {
      listState = createSessionListState(sessions);
    }
    if (activeSessionId) {
      const maxSeq = traceState.events.length
        ? traceState.events[traceState.events.length - 1]!.seq
        : -1;
      const fresh = await options.service.getEvents(activeSessionId, maxSeq - REFETCH_WINDOW);
      if (disposed) return;
      traceState = appendTraceEvents(traceState, fresh);
    }
    renderAll();
  };

  const isEscapeKey = (key: KeyInputLike) =>
    key.name === 'escape' || key.name === 'esc' || key.sequence === '\x1b';

  const onKeypress = (key: KeyInputLike) => {
    if (key.ctrl && key.name === 'c') {
      options.onQuit();
      return;
    }
    if (!progress.done) {
      if (!key.ctrl && !key.meta && key.name === 'q') options.onQuit();
      return;
    }

    // In-session find input mode captures typed characters
    if (activeSessionId && traceState.find.open && findInputFocused) {
      if (!key.ctrl && !key.meta && isEscapeKey(key)) {
        findInputFocused = false;
        dispatchTrace({ type: 'closeFind' });
        return;
      }
      if (!key.ctrl && !key.meta && (key.name === 'return' || key.name === 'enter')) {
        findInputFocused = false;
        renderFindBar();
        return;
      }
      if (!key.ctrl && !key.meta && key.name === 'backspace') {
        dispatchTrace({ type: 'setFindQuery', query: traceState.find.query.slice(0, -1) });
        return;
      }
      if (!key.ctrl && !key.meta) {
        let ch: string | null = null;
        if (key.name === 'space') ch = ' ';
        else if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ') ch = key.sequence;
        else if (key.name && key.name.length === 1) ch = key.shift ? key.name.toUpperCase() : key.name;
        if (ch !== null) {
          dispatchTrace({ type: 'setFindQuery', query: `${traceState.find.query}${ch}` });
          return;
        }
      }
      return;
    }

    // In-session find navigation mode (after Enter)
    if (activeSessionId && traceState.find.open && !key.ctrl && !key.meta) {
      if (isEscapeKey(key)) {
        dispatchTrace({ type: 'closeFind' });
        return;
      }
      if (key.name === 'n' && !key.shift) {
        dispatchTrace({ type: 'nextMatch' });
        return;
      }
      if ((key.name === 'n' && key.shift) || key.sequence === 'N') {
        dispatchTrace({ type: 'prevMatch' });
        return;
      }
      if (key.name === '/' || key.sequence === '/') {
        findInputFocused = true;
        renderFindBar();
        return;
      }
    }

    if (!key.ctrl && !key.meta && key.name === 'q') {
      options.onQuit();
      return;
    }
    if (!key.ctrl && !key.meta && ((key.shift && key.name === 's') || key.sequence === 'S')) {
      showSandboxDetail = !showSandboxDetail;
      renderSandboxDetail();
      return;
    }
    if (showSandboxDetail && !key.ctrl && !key.meta && isEscapeKey(key)) {
      showSandboxDetail = false;
      renderSandboxDetail();
      return;
    }
    if (activeSessionId && !traceState.find.open && !key.ctrl && !key.meta && (key.name === '/' || key.sequence === '/')) {
      findInputFocused = true;
      dispatchTrace({ type: 'openFind' });
      return;
    }

    if (!key.ctrl && !key.meta && key.name === 'tab' && activeSessionId) {
      const order: FocusPane[] = ['sessions', 'trace', 'detail'];
      const idx = order.indexOf(focus);
      focus = order[(idx + (key.shift ? order.length - 1 : 1)) % order.length]!;
      renderHeader();
      updatePaneBorders();
      return;
    }

    // 1-9 quick-open works across panes
    if (!key.ctrl && !key.meta && key.name && /^[1-9]$/.test(key.name)) {
      dispatchSessionList({ type: 'quickOpen', index: Number(key.name) });
      return;
    }

    if (focus === 'sessions') {
      const action = keyToSessionListAction(key);
      if (action) dispatchSessionList(action);
      return;
    }

    if (focus === 'trace') {
      if (!key.ctrl && !key.meta && key.name === 'e') {
        const node = getSelectedNode(traceState);
        if (node) dispatchTrace({ type: 'toggleOutputExpand', id: node.ev.id });
        return;
      }
      if (!key.ctrl && !key.meta && key.name === 'return') {
        focus = 'detail';
        renderHeader();
        updatePaneBorders();
        return;
      }
      const action = keyToTraceAction(key);
      if (action) dispatchTrace(action);
      return;
    }

    if (focus === 'detail') {
      if (!key.ctrl && !key.meta) {
        if (key.name === 'escape' || key.name === 'esc' || key.sequence === '\x1b' || key.name === 'h') {
          focus = 'trace';
          renderHeader();
          updatePaneBorders();
          return;
        }
        if (key.name === 'r') {
          dispatchTrace({ type: 'toggleRaw' });
          return;
        }
        if (key.name === 'e') {
          const node = getSelectedNode(traceState);
          if (node) dispatchTrace({ type: 'toggleOutputExpand', id: node.ev.id });
          return;
        }
        if (key.name === 'j' || key.name === 'down') {
          detailScroll.scrollBy(2);
          return;
        }
        if (key.name === 'k' || key.name === 'up') {
          detailScroll.scrollBy(-2);
          return;
        }
        if (key.name === 'pagedown') {
          detailScroll.scrollBy(10);
          return;
        }
        if (key.name === 'pageup') {
          detailScroll.scrollBy(-10);
          return;
        }
      }
    }
  };

  renderer.keyInput.on('keypress', onKeypress);

  const offProgress =
    options.service.onProgress?.((p) => {
      progress = p;
      if (p.done) {
        void refresh();
      } else {
        renderAll();
      }
    }) ?? (() => {});

  const offChange = options.service.onChange((_n: ChangeNotice) => {
    void refresh();
  });

  const offSandbox = options.service.onSandbox((s: SandboxState) => {
    sandbox = s;
    renderHeader();
    if (showSandboxDetail) renderSandboxDetail();
  });

  renderAll();
  if (!options.initiallyIndexing) {
    void refresh();
  }

  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      offProgress();
      offChange();
      offSandbox();
      renderer.keyInput.off('keypress', onKeypress);
      clearSandboxDetail();
      clearSessionRows();
      clearTraceRows();
      syntaxStyle.destroy();
      renderer.root.remove(root);
      root.destroyRecursively();
    },
  };
}
