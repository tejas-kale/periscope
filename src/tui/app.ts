import {
  BoxRenderable,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type SyntaxStyle,
  type TextChunk,
} from '@opentui/core';
import type { IndexProgress } from '../core/service.ts';
import type {
  ChangeNotice,
  EventRow,
  PeriscopeApi,
  SandboxState,
  SearchHit,
  SessionFilter,
  SessionRow,
} from '../core/types.ts';
import type { ThemeOption } from '../cli/args.ts';
import {
  formatSandboxDetail,
  formatSandboxStatus,
} from '../view-model/sandbox-status.ts';
import {
  buildSearchResultItems,
  cycleAgentFilter,
  cycleDatePreset,
  cycleHostFilter,
  cycleStatusFilter,
  dateRangeForPreset,
  formatFilterBar,
  hasActiveFilters,
  parseDateRangeInput,
  parseSnippet,
  type DateRangePreset,
  type SnippetSegment,
} from '../view-model/session-filter.ts';
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
  formatShowFilter,
  getSelectedNode,
  getVisibleRows,
  keyToTraceAction,
  type TraceAction,
  type TraceState,
} from '../view-model/trace.ts';
import { buildDetailModel, extractImageRefs } from '../view-model/detail.ts';
import { buildContextGroups, computeSessionStats } from '../view-model/stats-context.ts';
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
import {
  copyWithFallback,
  extractCodeBlockText,
  extractDiffText,
  extractStepCopyText,
  keyToCopyAction,
  type CopyAction,
} from '../view-model/clipboard.ts';
import { fmtDuration, fmtTokens, hint, type Row } from '../view-model/tree.ts';
import { createOpenTuiAdapter, type TuiAdapter } from './adapter.ts';
import { buildHighlightedStyledText } from './highlight.ts';
import {
  createDetailSyntaxStyle,
  getDetailPalette,
  renderContextContent,
  renderDetailContent,
  renderStatsContent,
  type LoadedImage,
} from './detail-pane.ts';

export interface PeriscopeAppService
  extends Pick<
    PeriscopeApi,
    'listSessions' | 'getEvents' | 'getRaw' | 'readImage' | 'search' | 'sandboxStatus' | 'onChange' | 'onSandbox'
  > {
  onProgress?(cb: (p: IndexProgress) => void): () => void;
}

export interface PeriscopeAppOptions {
  service: PeriscopeAppService;
  adapter?: Pick<TuiAdapter<CliRenderer>, 'detectCapabilities' | 'copyToClipboard'>;
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

type DetailMode = 'step' | 'stats' | 'context';
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
  matchFg: string;
  matchBg: string;
  borderFg: string;
  focusBorderFg: string;
  detailBg: string;
  footerBg: string;
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
      matchFg: '#713f12',
      matchBg: '#fef08a',
      borderFg: '#d1d5db',
      focusBorderFg: '#2563eb',
      detailBg: '#fef2f2',
      footerBg: '#e5e7eb',
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
    matchFg: '#fef08a',
    matchBg: '#854d0e',
    borderFg: '#374151',
    focusBorderFg: '#60a5fa',
    detailBg: '#2b1c1f',
    footerBg: '#1f2937',
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

function snippetToStyledText(segments: SnippetSegment[], palette: Palette, maxWidth: number): StyledText {
  const prefix = '      ';
  let remaining = Math.max(4, maxWidth - prefix.length);
  const chunks: TextChunk[] = [
    { __isChunk: true, text: prefix, fg: RGBA.fromHex(palette.mutedFg) },
  ];
  for (const seg of segments) {
    if (remaining <= 0) break;
    const text = seg.text.length > remaining ? `${seg.text.slice(0, Math.max(0, remaining - 1))}…` : seg.text;
    remaining -= text.length;
    if (!text) continue;
    if (seg.match) {
      chunks.push({
        __isChunk: true,
        text,
        fg: RGBA.fromHex(palette.matchFg),
        bg: RGBA.fromHex(palette.matchBg),
        attributes: TextAttributes.BOLD,
      });
    } else {
      chunks.push({
        __isChunk: true,
        text,
        fg: RGBA.fromHex(palette.mutedFg),
      });
    }
  }
  return new StyledText(chunks);
}

/** Mount the Periscope terminal UI (session list + windowed trace tree + detail pane). */
export function mountPeriscopeApp(renderer: CliRenderer, options: PeriscopeAppOptions): PeriscopeAppHandle {
  const adapter = options.adapter ?? createOpenTuiAdapter();
  const support = adapter.detectCapabilities(renderer);
  let themeSetting: ThemeOption = options.theme;
  let resolvedTheme: 'dark' | 'light' =
    themeSetting === 'auto' ? (renderer.themeMode ?? 'dark') : themeSetting;
  let palette = getPalette(resolvedTheme);
  let detailPalette = getDetailPalette(resolvedTheme);
  let syntaxStyle: SyntaxStyle = createDetailSyntaxStyle(renderer, resolvedTheme);
  const clock = options.clock ?? Date.now;

  let sessions: SessionRow[] = [];
  let sessionsById = new Map<string, SessionRow>();
  let listState: SessionListState = createSessionListState([]);
  let filter: SessionFilter = {};
  let datePreset: DateRangePreset = 'all';
  let dateLabel = 'All';
  let dateInputMode = false;
  let dateInputText = '';
  let dateInputError = '';
  let searchQuery = '';
  let searchInputMode = false;
  let searchHits: SearchHit[] | null = null;
  let searchCursorId: string | null = null;
  let searchGen = 0;

  let activeSessionId: string | null = null;
  let traceState: TraceState = createTraceState([]);
  let focus: FocusPane = 'sessions';
  let detailMode: DetailMode = 'step';
  let contextRawById = new Map<string, string | null>();
  let contextLoadGen = 0;
  let layoutState: LayoutState = createLayoutState();
  let loadedImages: LoadedImage[] = [];
  let imageLoadGen = 0;

  let sandbox: SandboxState = { state: 'unknown' };
  let showSandboxDetail = false;
  let showHelp = false;
  let findInputFocused = false;
  let statusMessage: string | null = null;
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

  const filterBar = new BoxRenderable(renderer, {
    height: 0,
    width: '100%',
    flexShrink: 0,
    backgroundColor: palette.headerBg,
  });
  const filterBarText = new TextRenderable(renderer, {
    content: '',
    fg: palette.mutedFg,
  });
  filterBar.add(filterBarText);

  const searchBar = new BoxRenderable(renderer, {
    height: 0,
    width: '100%',
    flexShrink: 0,
    backgroundColor: palette.cursorBg,
  });
  const searchBarText = new TextRenderable(renderer, {
    content: '',
    fg: palette.fg,
  });
  searchBar.add(searchBarText);

  const listScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: '100%',
    scrollY: true,
    scrollX: false,
  });
  sessionsPane.add(filterBar);
  sessionsPane.add(searchBar);
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

  const traceToolbarBox = new BoxRenderable(renderer, {
    height: 1,
    width: '100%',
    flexShrink: 0,
    backgroundColor: palette.headerBg,
  });
  const traceToolbarText = new TextRenderable(renderer, {
    content: '',
    fg: palette.headerFg,
  });
  traceToolbarBox.add(traceToolbarText);

  const traceRowsBox = new BoxRenderable(renderer, {
    flexDirection: 'column',
    flexGrow: 1,
    width: '100%',
  });
  tracePane.add(traceToolbarBox);
  tracePane.add(traceRowsBox);

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
      traceRowsBox.remove(entry.box);
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
    const followTag = activeSessionId
      ? traceState.follow
        ? ' [FOLLOW]'
        : ''
      : '';
    if (w <= 95) {
      const panePart = activeSessionId ? ` | ${focus}${zoomTag}${followTag}` : '';
      const raw = ` Periscope | ${resolvedTheme} | ${formatSandboxStatus(sandbox)}${panePart} | ? | q`;
      headerText.content = truncateText(raw, w);
      return;
    }
    const focusLabel = activeSessionId ? `  |  pane: ${focus}${zoomTag} (Tab)` : '';
    const followLabel = activeSessionId
      ? traceState.follow
        ? '  |  [FOLLOW] (f)'
        : '  |  follow: off (f)'
      : '';
    const raw = ` Periscope  |  theme: ${resolvedTheme}  |  ${formatSandboxStatus(sandbox)}${focusLabel}${followLabel}  |  ? help  |  q quit`;
    headerText.content = truncateText(raw, w);
  };

  const renderFooter = () => {
    const w = renderer.terminalWidth;
    if (statusMessage) {
      footerText.content = truncateText(` ${statusMessage}`, w);
      return;
    }
    const selected = listState.selectedSessionId
      ? sessionsById.get(listState.selectedSessionId)
      : undefined;
    const raw = selected
      ? ` Selected: ${selected.title || selected.id} (${formatAgent(selected.agent)}, ${formatHost(selected.host)})`
      : ` ${formatFilterBar(filter, dateLabel)}  |  ↑/↓ Nav  Enter Open  Help: ?`;
    footerText.content = truncateText(raw, w);
  };

  const renderFilterAndSearchBars = (paneWidth: number) => {
    const showFilter = progress.done && hasActiveFilters(filter);
    if (showFilter) {
      filterBar.height = 1;
      filterBarText.content = truncateText(` ${formatFilterBar(filter, dateLabel)}`, paneWidth);
    } else {
      filterBar.height = 0;
      filterBarText.content = '';
    }

    if (progress.done && dateInputMode) {
      searchBar.height = 1;
      const err = dateInputError ? ` [${dateInputError}]` : '';
      searchBarText.content = truncateText(` Date (YYYY-MM-DD..YYYY-MM-DD): ${dateInputText}▏${err}`, paneWidth);
    } else if (progress.done && (searchInputMode || searchQuery.length > 0)) {
      searchBar.height = 1;
      const countLabel = searchHits ? ` (${searchHits.length})` : '';
      const cursor = searchInputMode ? '▏' : '';
      searchBarText.content = truncateText(` Search: ${searchQuery}${cursor}${countLabel}`, paneWidth);
    } else {
      searchBar.height = 0;
      searchBarText.content = '';
    }
  };

  const performCopy = (text: string | null, label: string, emptyMessage: string) => {
    if (!text) {
      statusMessage = emptyMessage;
      renderFooter();
      return;
    }
    const result = copyWithFallback(text, {
      label,
      osc52Supported: support.osc52,
      copyOsc52: (value) => adapter.copyToClipboard(renderer, value),
    });
    statusMessage = result.statusMessage;
    renderFooter();
  };

  const handleCopyAction = (action: CopyAction) => {
    if (action.type === 'copySessionId' || action.type === 'copySourcePath') {
      const target =
        (activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined) ??
        (listState.selectedSessionId ? sessions.find((s) => s.id === listState.selectedSessionId) : undefined);
      if (!target) {
        statusMessage = 'No session selected';
        renderFooter();
        return;
      }
      if (action.type === 'copySessionId') {
        performCopy(target.id, 'session ID', 'No session ID');
      } else {
        performCopy(target.source_path, 'source path', 'No source path');
      }
      return;
    }

    const node = getSelectedNode(traceState);
    if (action.type === 'copyText') {
      performCopy(extractStepCopyText(node), 'step text', 'No step text to copy');
    } else if (action.type === 'copyCode') {
      performCopy(extractCodeBlockText(node), 'code block', 'No code block in selected step');
    } else if (action.type === 'copyDiff') {
      performCopy(extractDiffText(node), 'diff', 'No diff in selected step');
    }
  };

  const renderSessionsPane = () => {
    const widths = computePaneWidths(renderer.terminalWidth, layoutState, activeSessionId !== null);
    const paneWidth = Math.max(12, widths.sessions - 2);
    renderFilterAndSearchBars(paneWidth);
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

    const now = clock();

    if (searchHits !== null && searchQuery.trim().length > 0) {
      const items = buildSearchResultItems(searchHits, sessionsById);
      if (items.length === 0) {
        const box = new BoxRenderable(renderer, { height: 1, width: '100%' });
        box.add(new TextRenderable(renderer, { content: ' No matches.', fg: palette.mutedFg }));
        listScroll.add(box);
        sessionRowNodes.push(box);
        return;
      }

      if (!searchCursorId || !items.some((it) => it.session.id === searchCursorId)) {
        searchCursorId = items[0]!.session.id;
      }

      for (const item of items) {
        const isCursor = searchCursorId === item.session.id;
        const isSelected = listState.selectedSessionId === item.session.id;
        const bg = isSelected ? palette.selectedBg : isCursor ? palette.cursorBg : undefined;
        const fg = item.session.status === 'live' ? palette.liveFg : palette.fg;

        const onClickHit = () => {
          focus = 'sessions';
          searchInputMode = false;
          searchCursorId = item.session.id;
          listState = { ...listState, selectedSessionId: item.session.id, cursorKey: item.key };
          options.onSelectSession?.(item.session);
          void openSession(item.session, item.hit.event_id);
        };

        const rowBox = new BoxRenderable(renderer, {
          height: 1,
          width: '100%',
          flexShrink: 0,
          backgroundColor: bg,
          onMouseDown: onClickHit,
        });
        rowBox.add(
          new TextRenderable(renderer, {
            content: formatSessionRowText(
              {
                kind: 'session',
                key: item.key,
                project: item.session.project ?? '(no project)',
                session: item.session,
                quickIndex: item.quickIndex,
              },
              now,
              paneWidth,
            ),
            fg,
          }),
        );
        listScroll.add(rowBox);
        sessionRowNodes.push(rowBox);

        const snipBox = new BoxRenderable(renderer, {
          height: 1,
          width: '100%',
          flexShrink: 0,
          backgroundColor: bg,
          onMouseDown: onClickHit,
        });
        snipBox.add(
          new TextRenderable(renderer, {
            content: snippetToStyledText(parseSnippet(item.hit.snippet), palette, paneWidth),
          }),
        );
        listScroll.add(snipBox);
        sessionRowNodes.push(snipBox);
      }
      return;
    }

    if (sessions.length === 0) {
      const box = new BoxRenderable(renderer, { height: 1, width: '100%' });
      box.add(new TextRenderable(renderer, { content: ' No sessions found.', fg: palette.mutedFg }));
      listScroll.add(box);
      sessionRowNodes.push(box);
      return;
    }

    const items = buildSessionListItems(sessions, listState);

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

  const traceViewportHeight = () => {
    const detailH = showSandboxDetail && typeof sandboxDetailBox.height === 'number' ? sandboxDetailBox.height : 0;
    const findH = activeSessionId && traceState.find.open ? 1 : 0;
    return Math.max(1, renderer.terminalHeight - 3 - detailH - findH);
  };

  const renderTraceToolbar = () => {
    const widths = computePaneWidths(renderer.terminalWidth, layoutState, activeSessionId !== null);
    const paneWidth = Math.max(16, widths.trace - 2);
    const showLabel = formatShowFilter(traceState.show);
    const collapseLabel = traceState.collapseAll ? 'Expand(z)' : 'Collapse(z)';
    const statsLabel = detailMode === 'stats' ? '[Stats(s)]' : 'Stats(s)';
    const ctxLabel = detailMode === 'context' ? '[Ctx(x)]' : 'Ctx(x)';
    traceToolbarText.content = truncateText(
      ` Show: ${showLabel} (v) | ${collapseLabel} | ${statsLabel} | ${ctxLabel}`,
      paneWidth,
    );
  };

  const renderTracePane = () => {
    if (!activeSessionId || layoutState.detailZoomed) {
      clearTraceRows();
      traceToolbarText.content = '';
      return;
    }
    renderTraceToolbar();
    const rows = getVisibleRows(traceState);
    const vpHeight = traceViewportHeight();
    const { visibleRows } = computeWindow(rows, traceState.scrollOffset, vpHeight, 4);
    const widths = computePaneWidths(renderer.terminalWidth, layoutState, true);
    const paneWidth = Math.max(16, widths.trace - 3);

    const keepIds = new Set(visibleRows.map((r) => r.node.ev.id));
    for (const [id, entry] of traceRowNodes.entries()) {
      if (!keepIds.has(id)) {
        traceRowsBox.remove(entry.box);
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
        traceRowsBox.add(box, i);
        entry = { box, text };
        traceRowNodes.set(id, entry);
      } else {
        entry.box.backgroundColor = bg ?? 'transparent';
        entry.text.content = content;
        entry.text.fg = fg;
        if (traceRowsBox.getChildren()[i] !== entry.box) {
          traceRowsBox.add(entry.box, i);
        }
      }
    }
  };

  const loadContextRaw = async () => {
    const gen = ++contextLoadGen;
    const groups = buildContextGroups(traceState.events, contextRawById);
    let updated = false;
    for (const g of groups) {
      if (contextRawById.has(g.latestEvent.id)) continue;
      try {
        const raw = await options.service.getRaw(g.latestEvent.id);
        if (disposed || gen !== contextLoadGen) return;
        contextRawById.set(g.latestEvent.id, raw);
        updated = true;
      } catch {
        // Ignore raw read errors for individual context items
      }
    }
    if (updated && !disposed && gen === contextLoadGen && detailMode === 'context') {
      renderDetailPane();
    }
  };

  const renderDetailPane = () => {
    if (!activeSessionId) return;
    if (detailMode === 'stats') {
      renderStatsContent({
        renderer,
        scrollBox: detailScroll,
        stats: computeSessionStats(traceState.tree, traceState.events),
        palette: detailPalette,
        onClose: () => {
          detailMode = 'step';
          renderTraceToolbar();
          renderDetailPane();
        },
      });
      return;
    }
    if (detailMode === 'context') {
      renderContextContent({
        renderer,
        scrollBox: detailScroll,
        groups: buildContextGroups(traceState.events, contextRawById),
        palette: detailPalette,
        onClose: () => {
          detailMode = 'step';
          renderTraceToolbar();
          renderDetailPane();
        },
      });
      return;
    }
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

  const renderLayout = () => {
    if (disposed) return;
    updatePaneVisibility();
    renderHeader();
    renderSandboxDetail();
    renderFindBar();
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

  const openSession = async (session: SessionRow, focusEventId?: string | null) => {
    if (activeSessionId === session.id && traceState.events.length > 0 && focusEventId) {
      focus = 'trace';
      traceState = applyTraceAction(
        traceState,
        { type: 'selectId', id: focusEventId, scrollIntoView: true },
        traceViewportHeight(),
      );
      renderAll();
      void loadImagesForSelectedStep();
      return;
    }

    activeSessionId = session.id;
    focus = 'trace';
    detailMode = 'step';
    contextRawById = new Map();
    findInputFocused = false;
    loadedImages = [];
    traceState = createTraceState([]);
    renderAll();

    const events = await options.service.getEvents(session.id);
    if (disposed || activeSessionId !== session.id) return;
    traceState = createTraceState(events, focusEventId);
    if (focusEventId) {
      traceState = applyTraceAction(
        traceState,
        { type: 'selectId', id: focusEventId, scrollIntoView: true },
        traceViewportHeight(),
      );
    }
    renderAll();
    void loadImagesForSelectedStep();
  };

  const openSearchHit = (hit: SearchHit) => {
    const session = sessionsById.get(hit.session_id);
    if (!session) return;
    searchInputMode = false;
    searchCursorId = session.id;
    listState = { ...listState, selectedSessionId: session.id, cursorKey: `s:${session.id}` };
    options.onSelectSession?.(session);
    void openSession(session, hit.event_id);
  };

  const runSearch = async () => {
    const gen = ++searchGen;
    const q = searchQuery.trim();
    if (!q) {
      searchHits = null;
      searchCursorId = null;
      renderSessionsPane();
      renderFooter();
      return;
    }
    const hits = await options.service.search(q, filter);
    if (disposed || gen !== searchGen) return;
    searchHits = hits;
    if (!searchCursorId || !hits.some((h) => h.session_id === searchCursorId)) {
      searchCursorId = hits[0]?.session_id ?? null;
    }
    renderSessionsPane();
    renderFooter();
  };

  const dispatchSessionList = (action: Parameters<typeof applySessionListAction>[2]) => {
    statusMessage = null;
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
    const hadStatus = statusMessage !== null;
    statusMessage = null;
    const prevSel = traceState.selectedId;
    const prevRaw = traceState.rawMode;
    const prevFollow = traceState.follow;
    const prevExp = prevSel ? traceState.outputExpanded.get(prevSel) : undefined;
    const prevFind = traceState.find;
    traceState = applyTraceAction(traceState, action, traceViewportHeight());
    renderFindBar();
    renderTracePane();
    if (traceState.follow !== prevFollow) {
      renderHeader();
    }
    if (hadStatus) renderFooter();

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
      if (detailMode === 'step') {
        renderDetailPane();
      }
    }
  };

  let refreshing = false;
  let queuedAll = false;
  let queuedIds = new Set<string>();

  const runRefresh = async (changedIds?: string[]) => {
    if (disposed) return;
    const [nextSessions, nextSandbox] = await Promise.all([
      options.service.listSessions(filter),
      options.service.sandboxStatus(),
    ]);
    if (disposed) return;
    sessions = nextSessions;
    sessionsById = new Map(sessions.map((s) => [s.id, s]));
    sandbox = nextSandbox;
    if (!listState.cursorKey && sessions.length > 0) {
      listState = createSessionListState(sessions);
    }
    if (searchQuery.trim().length > 0) {
      const gen = ++searchGen;
      const hits = await options.service.search(searchQuery.trim(), filter);
      if (disposed) return;
      if (gen === searchGen) {
        searchHits = hits;
      }
    }

    let traceChanged = false;
    let detailChanged = false;
    let selectionChanged = false;

    const currentSessionId = activeSessionId;
    if (currentSessionId && (!changedIds || changedIds.includes(currentSessionId))) {
      const maxSeq = traceState.events.length
        ? traceState.events[traceState.events.length - 1]!.seq
        : -1;
      const fresh = await options.service.getEvents(currentSessionId, maxSeq - REFETCH_WINDOW);
      if (disposed) return;
      if (activeSessionId === currentSessionId) {
        const prevTrace = traceState;
        traceState = appendTraceEvents(traceState, fresh, traceViewportHeight());
        traceChanged = traceState !== prevTrace;
        selectionChanged = traceState.selectedId !== prevTrace.selectedId;
        detailChanged =
          selectionChanged ||
          (traceChanged &&
            traceState.selectedId !== null &&
            fresh.some(
              (ev) => ev.id === traceState.selectedId || ev.parent_id === traceState.selectedId,
            ));
      }
    }

    updatePaneVisibility();
    renderHeader();
    if (showSandboxDetail) renderSandboxDetail();
    renderSessionsPane();
    if (traceChanged) renderTracePane();
    if (selectionChanged) {
      loadedImages = [];
      void loadImagesForSelectedStep();
    }
    if (detailChanged) renderDetailPane();
    renderFooter();
  };

  const refresh = async (changedIds?: string[]) => {
    if (disposed) return;
    if (refreshing) {
      if (!changedIds) queuedAll = true;
      else for (const id of changedIds) queuedIds.add(id);
      return;
    }
    refreshing = true;
    try {
      await runRefresh(changedIds);
      while (!disposed && (queuedAll || queuedIds.size > 0)) {
        const nextIds = queuedAll ? undefined : [...queuedIds];
        queuedAll = false;
        queuedIds.clear();
        await runRefresh(nextIds);
      }
    } finally {
      refreshing = false;
    }
  };

  const applyFilterChange = async () => {
    await refresh();
  };

  const handleDateInputKey = (key: KeyInputLike) => {
    const name = key.name ?? '';
    if (name === 'escape' || name === 'esc' || key.sequence === '\x1b') {
      dateInputMode = false;
      dateInputError = '';
      renderSessionsPane();
      return;
    }
    if (name === 'return' || name === 'enter') {
      const parsed = parseDateRangeInput(dateInputText);
      if (!parsed) {
        dateInputError = 'Use YYYY-MM-DD..YYYY-MM-DD';
        renderSessionsPane();
        return;
      }
      filter = { ...filter, from: parsed.from, to: parsed.to };
      datePreset = 'custom';
      dateLabel = parsed.label;
      dateInputMode = false;
      dateInputError = '';
      void applyFilterChange();
      return;
    }
    if (name === 'backspace') {
      dateInputText = dateInputText.slice(0, -1);
      dateInputError = '';
      renderSessionsPane();
      return;
    }
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1 && key.sequence >= ' ') {
      dateInputText += key.sequence;
      dateInputError = '';
      renderSessionsPane();
    }
  };

  const handleSearchInputKey = (key: KeyInputLike) => {
    const name = key.name ?? '';
    if (name === 'escape' || name === 'esc' || key.sequence === '\x1b') {
      searchQuery = '';
      searchHits = null;
      searchInputMode = false;
      searchCursorId = null;
      renderSessionsPane();
      renderFooter();
      return;
    }
    if (name === 'down') {
      searchInputMode = false;
      renderSessionsPane();
      return;
    }
    if (name === 'return' || name === 'enter') {
      searchInputMode = false;
      if (searchHits && searchHits.length > 0) {
        openSearchHit(searchHits[0]!);
      } else if (searchQuery.trim().length > 0) {
        void runSearch().then(() => {
          if (!disposed && searchHits && searchHits.length > 0) {
            openSearchHit(searchHits[0]!);
          }
        });
      } else {
        renderSessionsPane();
      }
      return;
    }
    if (name === 'backspace') {
      searchQuery = searchQuery.slice(0, -1);
      void runSearch();
      return;
    }
    if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1 && key.sequence >= ' ') {
      searchQuery += key.sequence;
      void runSearch();
    }
  };

  const handleSearchListKey = (key: KeyInputLike): boolean => {
    if (searchHits === null) return false;
    const items = buildSearchResultItems(searchHits, sessionsById);
    const name = key.name ?? '';
    if (name === 'escape' || name === 'esc' || key.sequence === '\x1b') {
      searchQuery = '';
      searchHits = null;
      searchCursorId = null;
      renderSessionsPane();
      renderFooter();
      return true;
    }
    if (name === 'return' || name === 'enter') {
      const target = items.find((it) => it.session.id === searchCursorId) ?? items[0];
      if (target) openSearchHit(target.hit);
      return true;
    }
    if (items.length === 0) return false;
    const curIdx = Math.max(0, items.findIndex((it) => it.session.id === searchCursorId));
    if (name === 'down' || (!key.shift && name === 'j')) {
      searchCursorId = items[Math.min(items.length - 1, curIdx + 1)]!.session.id;
      renderSessionsPane();
      return true;
    }
    if (name === 'up' || (!key.shift && name === 'k')) {
      searchCursorId = items[Math.max(0, curIdx - 1)]!.session.id;
      renderSessionsPane();
      return true;
    }
    if ((key.shift && name === 'g') || key.sequence === 'G') {
      searchCursorId = items[items.length - 1]!.session.id;
      renderSessionsPane();
      return true;
    }
    if (!key.shift && name === 'g') {
      searchCursorId = items[0]!.session.id;
      renderSessionsPane();
      return true;
    }
    return false;
  };

  const isEscapeKey = (key: KeyInputLike) =>
    key.name === 'escape' || key.name === 'esc' || key.sequence === '\x1b';

  const onKeypress = (key: KeyInputLike) => {
    if (key.ctrl && key.name === 'c') {
      options.onQuit();
      return;
    }
    if (progress.done && dateInputMode) {
      handleDateInputKey(key);
      return;
    }
    if (progress.done && searchInputMode) {
      handleSearchInputKey(key);
      return;
    }

    // In-session find input mode captures typed characters
    if (progress.done && activeSessionId && traceState.find.open && findInputFocused) {
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
    if (showSandboxDetail && !key.ctrl && !key.meta && isEscapeKey(key)) {
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
      if ((focus === 'trace' || focus === 'detail') && (key.name === '/' || key.sequence === '/')) {
        findInputFocused = true;
        renderFindBar();
        return;
      }
    }

    if (
      activeSessionId &&
      (focus === 'trace' || focus === 'detail') &&
      !traceState.find.open &&
      !key.ctrl &&
      !key.meta &&
      (key.name === '/' || key.sequence === '/')
    ) {
      findInputFocused = true;
      dispatchTrace({ type: 'openFind' });
      return;
    }

    if (key.ctrl && !key.meta && key.name === 'k') {
      focus = 'sessions';
      searchInputMode = true;
      renderHeader();
      updatePaneBorders();
      renderSessionsPane();
      return;
    }

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
      if ((key.shift && key.name === 'z') || key.sequence === 'Z') {
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
      const n = Number(key.name);
      if (searchHits !== null && searchQuery.trim().length > 0) {
        const items = buildSearchResultItems(searchHits, sessionsById);
        const target = items[n - 1];
        if (target) openSearchHit(target.hit);
        return;
      }
      dispatchSessionList({ type: 'quickOpen', index: n });
      return;
    }

    const copyAction = keyToCopyAction(key);
    if (copyAction) {
      if (copyAction.type === 'copySessionId' || copyAction.type === 'copySourcePath') {
        handleCopyAction(copyAction);
        return;
      }
      if (activeSessionId && (focus === 'trace' || focus === 'detail')) {
        handleCopyAction(copyAction);
        return;
      }
    }

    if (focus === 'sessions') {
      if (!key.ctrl && !key.meta) {
        if (key.sequence === '/' || key.name === '/') {
          searchInputMode = true;
          renderSessionsPane();
          return;
        }
        if (!key.shift && key.name === 'a') {
          filter = { ...filter, agent: cycleAgentFilter(filter.agent) };
          void applyFilterChange();
          return;
        }
        if ((!key.shift && key.name === 'o') || (key.shift && key.name === 'h') || key.sequence === 'H') {
          filter = { ...filter, host: cycleHostFilter(filter.host) };
          void applyFilterChange();
          return;
        }
        if (!key.shift && key.name === 's') {
          filter = { ...filter, status: cycleStatusFilter(filter.status) };
          void applyFilterChange();
          return;
        }
        if (!key.shift && key.name === 'd') {
          datePreset = cycleDatePreset(datePreset);
          dateLabel = datePreset === 'all' ? 'All' : datePreset;
          const range = dateRangeForPreset(datePreset, clock());
          filter = { ...filter, from: range.from, to: range.to };
          void applyFilterChange();
          return;
        }
        if ((key.shift && key.name === 'd') || key.sequence === 'D') {
          dateInputMode = true;
          dateInputText = '';
          dateInputError = '';
          renderSessionsPane();
          return;
        }
        if (!key.shift && key.name === 'c') {
          filter = {};
          datePreset = 'all';
          dateLabel = 'All';
          void applyFilterChange();
          return;
        }
      }
      if (searchHits !== null && searchQuery.trim().length > 0) {
        if (handleSearchListKey(key)) return;
      }
      const action = keyToSessionListAction(key);
      if (action) dispatchSessionList(action);
      return;
    }

    if (focus === 'trace' || focus === 'detail') {
      if (!key.ctrl && !key.meta && !key.shift) {
        if (key.name === 's') {
          detailMode = detailMode === 'stats' ? 'step' : 'stats';
          renderTraceToolbar();
          renderDetailPane();
          return;
        }
        if (key.name === 'x') {
          detailMode = detailMode === 'context' ? 'step' : 'context';
          renderTraceToolbar();
          renderDetailPane();
          if (detailMode === 'context') void loadContextRaw();
          return;
        }
        if (key.name === 'v') {
          dispatchTrace({ type: 'cycleShow' });
          return;
        }
        if (key.name === 'z') {
          dispatchTrace({ type: 'toggleCollapseAll' });
          return;
        }
      }
    }

    if (focus === 'trace') {
      if (!key.ctrl && !key.meta && key.name === 'e') {
        const node = getSelectedNode(traceState);
        if (node) dispatchTrace({ type: 'toggleOutputExpand', id: node.ev.id });
        return;
      }
      if (!key.ctrl && !key.meta && key.name === 'return') {
        detailMode = 'step';
        focus = 'detail';
        renderHeader();
        updatePaneBorders();
        renderTraceToolbar();
        renderDetailPane();
        return;
      }
      const action = keyToTraceAction(key);
      if (action) dispatchTrace(action);
      return;
    }

    if (focus === 'detail') {
      if (!key.ctrl && !key.meta) {
        if (key.name === 'escape' || key.name === 'esc' || key.sequence === '\x1b' || key.name === 'h') {
          if (detailMode !== 'step' && key.name !== 'h') {
            detailMode = 'step';
            renderTraceToolbar();
            renderDetailPane();
            return;
          }
          focus = 'trace';
          renderHeader();
          updatePaneBorders();
          return;
        }
        if (key.name === 'r') {
          dispatchTrace({ type: 'toggleRaw' });
          return;
        }
        if (key.name === 'f') {
          dispatchTrace({ type: 'toggleFollow' });
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

  const offChange = options.service.onChange((n: ChangeNotice) => {
    void refresh(n.sessionIds);
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
