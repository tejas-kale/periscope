import {
  BoxRenderable,
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
import { formatHelpLines } from '../view-model/keymap.ts';
import {
  computePaneWidths,
  createLayoutState,
  resetPaneWidths,
  resizePane,
  toggleDetailZoom,
  type FocusPane,
  type LayoutState,
} from '../view-model/layout.ts';
import { fmtDuration, fmtTokens, hint, type Row } from '../view-model/tree.ts';
import { detectCapabilities } from './adapter.ts';
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
  const rawTitle = (s.title || s.id).replace(/\s+/g, ' ').trim();
  if (maxWidth < 38) {
    return truncateText(`${prefix}${rawTitle}`, maxWidth);
  }
  const titleBudget = Math.max(8, maxWidth - prefix.length - suffix.length);
  const title = truncateText(rawTitle, titleBudget);
  return truncateText(`${prefix}${title}${suffix}`, maxWidth);
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
  return truncateText(`${prefix}${body}${suffix}`, maxWidth);
}

function decodeBase64DataUrl(dataUrl: string): Buffer | undefined {
  const idx = dataUrl.indexOf(',');
  if (idx === -1) return undefined;
  return Buffer.from(dataUrl.slice(idx + 1), 'base64');
}

/** Mount the Periscope terminal UI (session list + windowed trace tree + detail pane). */
export function mountPeriscopeApp(renderer: CliRenderer, options: PeriscopeAppOptions): PeriscopeAppHandle {
  const support = detectCapabilities(renderer);
  let themeSetting: ThemeOption = options.theme;
  let resolvedTheme: 'dark' | 'light' =
    themeSetting === 'auto' ? (renderer.themeMode ?? 'dark') : themeSetting;
  let palette = getPalette(resolvedTheme);
  let detailPalette = getDetailPalette(resolvedTheme);
  let syntaxStyle: SyntaxStyle = createDetailSyntaxStyle(renderer, resolvedTheme);
  const clock = options.clock ?? Date.now;

  let sessions: SessionRow[] = [];
  let listState: SessionListState = createSessionListState([]);
  let activeSessionId: string | null = null;
  let traceState: TraceState = createTraceState([]);
  let focus: FocusPane = 'sessions';
  let layoutState: LayoutState = createLayoutState();
  let loadedImages: LoadedImage[] = [];
  let imageLoadGen = 0;

  let sandbox: SandboxState = { state: 'unknown' };
  let showSandboxDetail = false;
  let showHelp = false;
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
  root.add(bodyRow);
  root.add(footerBar);

  const helpOverlay = new BoxRenderable(renderer, {
    position: 'absolute',
    zIndex: 50,
    top: 2,
    left: 4,
    width: 64,
    height: 20,
    flexDirection: 'column',
    border: true,
    borderColor: palette.focusBorderFg,
    backgroundColor: palette.headerBg,
    paddingLeft: 1,
    paddingRight: 1,
    visible: false,
  });
  const helpTitle = new TextRenderable(renderer, {
    content: 'Keyboard Shortcuts  (? / Esc to close)',
    fg: palette.groupFg,
    height: 1,
  });
  const helpScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: '100%',
    scrollY: true,
    scrollX: false,
  });
  helpOverlay.add(helpTitle);
  helpOverlay.add(helpScroll);
  root.add(helpOverlay);
  renderer.root.add(root);

  let sessionRowNodes: BoxRenderable[] = [];
  let sandboxDetailNodes: TextRenderable[] = [];
  let helpLineNodes: TextRenderable[] = [];
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
    const widths = computePaneWidths(renderer.terminalWidth, layoutState, hasSession);
    if (!hasSession) {
      sessionsPane.width = widths.sessions;
      sessionsPane.visible = true;
      tracePane.width = 0;
      tracePane.visible = false;
      detailPane.width = 0;
      detailPane.visible = false;
    } else if (layoutState.detailZoomed) {
      sessionsPane.width = 0;
      sessionsPane.visible = false;
      tracePane.width = 0;
      tracePane.visible = false;
      detailPane.width = widths.detail;
      detailPane.visible = true;
    } else {
      sessionsPane.width = widths.sessions;
      sessionsPane.visible = true;
      tracePane.width = widths.trace;
      tracePane.visible = true;
      detailPane.width = widths.detail;
      detailPane.visible = true;
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

  const clearHelpLines = () => {
    for (const node of helpLineNodes) {
      helpScroll.remove(node);
      node.destroyRecursively();
    }
    helpLineNodes = [];
  };

  const renderHelpOverlay = () => {
    clearHelpLines();
    if (!showHelp) {
      helpOverlay.visible = false;
      return;
    }
    const w = Math.min(72, Math.max(40, renderer.terminalWidth - 4));
    const h = Math.min(36, Math.max(12, renderer.terminalHeight - 4));
    helpOverlay.width = w;
    helpOverlay.height = h;
    helpOverlay.left = Math.max(0, Math.floor((renderer.terminalWidth - w) / 2));
    helpOverlay.top = Math.max(0, Math.floor((renderer.terminalHeight - h) / 2));
    helpOverlay.backgroundColor = palette.headerBg;
    helpOverlay.borderColor = palette.focusBorderFg;
    helpTitle.content = truncateText('Keyboard Shortcuts  (? / Esc to close)', Math.max(20, w - 4));
    helpTitle.fg = palette.groupFg;

    const lines = formatHelpLines(Math.max(20, w - 4));
    for (const line of lines) {
      const isSection = line.length > 0 && !line.startsWith('  ');
      const node = new TextRenderable(renderer, {
        content: line,
        fg: isSection ? palette.groupFg : palette.fg,
      });
      helpScroll.add(node);
      helpLineNodes.push(node);
    }
    helpOverlay.visible = true;
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
    const w = renderer.terminalWidth;
    const zoomTag = layoutState.detailZoomed ? ' [zoom]' : '';
    if (w <= 95) {
      const panePart = activeSessionId ? ` | ${focus}${zoomTag}` : '';
      const raw = ` Periscope | ${resolvedTheme} | ${formatSandboxStatus(sandbox)}${panePart} | ? | q`;
      headerText.content = truncateText(raw, w);
      return;
    }
    const focusLabel = activeSessionId ? `  |  pane: ${focus}${zoomTag} (Tab)` : '';
    const raw = ` Periscope  |  theme: ${resolvedTheme}  |  ${formatSandboxStatus(sandbox)}${focusLabel}  |  ? help  |  q quit`;
    headerText.content = truncateText(raw, w);
  };

  const renderFooter = () => {
    const w = renderer.terminalWidth;
    const selected = listState.selectedSessionId
      ? sessions.find((s) => s.id === listState.selectedSessionId)
      : undefined;
    const raw = selected
      ? ` Selected: ${selected.title || selected.id} (${formatAgent(selected.agent)}, ${formatHost(selected.host)})`
      : ' Navigate: ↑/↓/j/k  Toggle: Space/←/→  Quick-open: 1-9  Open: Enter  Help: ?';
    footerText.content = truncateText(raw, w);
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
    const widths = computePaneWidths(renderer.terminalWidth, layoutState, activeSessionId !== null);
    const paneWidth = Math.max(12, widths.sessions - 2);

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

  const traceViewportHeight = () => {
    const detailH = typeof sandboxDetailBox.height === 'number' ? sandboxDetailBox.height : 0;
    return Math.max(1, renderer.terminalHeight - 2 - detailH);
  };

  const renderTracePane = () => {
    if (!activeSessionId || layoutState.detailZoomed) {
      clearTraceRows();
      return;
    }
    const rows = getVisibleRows(traceState);
    const vpHeight = traceViewportHeight();
    const { visibleRows } = computeWindow(rows, traceState.scrollOffset, vpHeight, 4);
    const widths = computePaneWidths(renderer.terminalWidth, layoutState, true);
    const paneWidth = Math.max(16, widths.trace - 3);

    const keepIds = new Set(visibleRows.map((r) => r.node.ev.id));
    for (const [id, entry] of traceRowNodes.entries()) {
      if (!keepIds.has(id)) {
        tracePane.remove(entry.box);
        entry.box.destroyRecursively();
        traceRowNodes.delete(id);
      }
    }

    for (let i = 0; i < visibleRows.length; i++) {
      const row = visibleRows[i]!;
      const id = row.node.ev.id;
      const isSel = traceState.selectedId === id;
      const isErr = row.node.ev.kind === 'error' || row.node.failed;
      const bg = isSel ? palette.selectedBg : undefined;
      const fg = isErr ? palette.errorFg : palette.fg;
      const label = formatTraceRowText(row, paneWidth);

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
        const text = new TextRenderable(renderer, { content: label, fg });
        box.add(text);
        tracePane.add(box, i);
        entry = { box, text };
        traceRowNodes.set(id, entry);
      } else {
        entry.box.backgroundColor = bg ?? 'transparent';
        entry.text.content = label;
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

  const renderLayout = () => {
    if (disposed) return;
    updatePaneVisibility();
    renderHeader();
    renderSandboxDetail();
    renderSessionsPane();
    renderTracePane();
    renderFooter();
    renderHelpOverlay();
  };

  const renderAll = () => {
    if (disposed) return;
    renderLayout();
    renderDetailPane();
  };

  const applyTheme = (nextMode: 'dark' | 'light') => {
    if (disposed || nextMode === resolvedTheme) return;
    resolvedTheme = nextMode;
    palette = getPalette(resolvedTheme);
    detailPalette = getDetailPalette(resolvedTheme);
    syntaxStyle.destroy();
    syntaxStyle = createDetailSyntaxStyle(renderer, resolvedTheme);
    headerBar.backgroundColor = palette.headerBg;
    headerText.fg = palette.headerFg;
    footerBar.backgroundColor = palette.footerBg;
    footerText.fg = palette.headerFg;
    renderAll();
  };

  const openSession = async (session: SessionRow) => {
    activeSessionId = session.id;
    focus = 'trace';
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
    traceState = applyTraceAction(traceState, action, traceViewportHeight());
    renderTracePane();

    const nextSel = traceState.selectedId;
    const nextExp = nextSel ? traceState.outputExpanded.get(nextSel) : undefined;
    if (nextSel !== prevSel || traceState.rawMode !== prevRaw || nextExp !== prevExp) {
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

  const onKeypress = (key: KeyInputLike) => {
    if (key.ctrl && key.name === 'c') {
      options.onQuit();
      return;
    }
    if (!key.ctrl && !key.meta && key.name === 'q') {
      options.onQuit();
      return;
    }
    if (!key.ctrl && !key.meta && (key.sequence === '?' || (key.shift && key.name === '/'))) {
      showHelp = !showHelp;
      renderHelpOverlay();
      return;
    }
    if (showHelp) {
      if (!key.ctrl && !key.meta) {
        if (key.name === 'escape' || key.name === 'esc' || key.sequence === '\x1b') {
          showHelp = false;
          renderHelpOverlay();
          return;
        }
        if (key.name === 'j' || key.name === 'down') {
          helpScroll.scrollBy(1);
          return;
        }
        if (key.name === 'k' || key.name === 'up') {
          helpScroll.scrollBy(-1);
          return;
        }
        if (key.name === 'pagedown') {
          helpScroll.scrollBy(8);
          return;
        }
        if (key.name === 'pageup') {
          helpScroll.scrollBy(-8);
          return;
        }
      }
      return;
    }
    if (!key.ctrl && !key.meta && ((key.shift && key.name === 's') || key.sequence === 'S')) {
      showSandboxDetail = !showSandboxDetail;
      renderSandboxDetail();
      return;
    }
    if (showSandboxDetail && !key.ctrl && !key.meta && key.name === 'escape') {
      showSandboxDetail = false;
      renderSandboxDetail();
      return;
    }
    if (!key.ctrl && !key.meta && !key.shift && (key.name === 't' || key.sequence === 't')) {
      const nextMode: 'dark' | 'light' = resolvedTheme === 'dark' ? 'light' : 'dark';
      themeSetting = nextMode;
      applyTheme(nextMode);
      return;
    }
    if (!progress.done) return;

    if (!key.ctrl && !key.meta && key.name === 'tab' && activeSessionId) {
      if (layoutState.detailZoomed) {
        layoutState = toggleDetailZoom(layoutState);
      }
      const order: FocusPane[] = ['sessions', 'trace', 'detail'];
      const idx = order.indexOf(focus);
      focus = order[(idx + (key.shift ? order.length - 1 : 1)) % order.length]!;
      renderLayout();
      return;
    }

    if (!key.ctrl && !key.meta && activeSessionId) {
      if (key.name === 'z' || key.sequence === 'z') {
        layoutState = toggleDetailZoom(layoutState);
        if (layoutState.detailZoomed) focus = 'detail';
        renderLayout();
        return;
      }
      if ((key.name === '[' || key.sequence === '[') && !layoutState.detailZoomed) {
        layoutState = resizePane(layoutState, focus, -4);
        renderLayout();
        return;
      }
      if ((key.name === ']' || key.sequence === ']') && !layoutState.detailZoomed) {
        layoutState = resizePane(layoutState, focus, 4);
        renderLayout();
        return;
      }
      if (key.name === '=' || key.sequence === '=') {
        layoutState = resetPaneWidths(layoutState);
        renderLayout();
        return;
      }
      if (layoutState.detailZoomed && (key.name === 'escape' || key.name === 'esc' || key.sequence === '\x1b')) {
        layoutState = toggleDetailZoom(layoutState);
        renderLayout();
        return;
      }
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

  const onResize = () => {
    renderLayout();
  };

  const onThemeMode = (mode: unknown) => {
    if (themeSetting === 'auto' && (mode === 'dark' || mode === 'light')) {
      applyTheme(mode);
    }
  };

  renderer.keyInput.on('keypress', onKeypress);
  renderer.on('resize', onResize);
  renderer.on('theme_mode', onThemeMode);

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
      renderer.off('resize', onResize);
      renderer.off('theme_mode', onThemeMode);
      clearSandboxDetail();
      clearHelpLines();
      clearSessionRows();
      clearTraceRows();
      syntaxStyle.destroy();
      renderer.root.remove(root);
      root.destroyRecursively();
    },
  };
}
