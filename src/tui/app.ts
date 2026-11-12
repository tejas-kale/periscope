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
  getSelectedNode,
  getVisibleRows,
  keyToTraceAction,
  type TraceAction,
  type TraceState,
} from '../view-model/trace.ts';
import { buildDetailModel, extractImageRefs } from '../view-model/detail.ts';
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
import {
  createDetailSyntaxStyle,
  getDetailPalette,
  renderDetailContent,
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
  matchFg: string;
  matchBg: string;
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
      matchFg: '#713f12',
      matchBg: '#fef08a',
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
    matchFg: '#fef08a',
    matchBg: '#854d0e',
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
  const resolvedTheme: 'dark' | 'light' =
    options.theme === 'auto' ? (renderer.themeMode ?? 'dark') : options.theme;
  const palette = getPalette(resolvedTheme);
  const detailPalette = getDetailPalette(resolvedTheme);
  const syntaxStyle: SyntaxStyle = createDetailSyntaxStyle(renderer, resolvedTheme);
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
  let loadedImages: LoadedImage[] = [];
  let imageLoadGen = 0;

  let sandbox: SandboxState = { state: 'unknown' };
  let showSandboxDetail = false;
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
    if (statusMessage) {
      footerText.content = ` ${statusMessage}`;
      return;
    }
    const selected = listState.selectedSessionId
      ? sessionsById.get(listState.selectedSessionId)
      : undefined;
    if (selected) {
      footerText.content = ` Selected: ${selected.title || selected.id} (${formatAgent(selected.agent)}, ${formatHost(selected.host)})`;
    } else {
      footerText.content = ` ${formatFilterBar(filter, dateLabel)}  |  ↑/↓ Nav  Enter Open`;
    }
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
    const paneWidth = activeSessionId
      ? Math.max(20, Math.floor(renderer.terminalWidth * 0.26) - 2)
      : Math.max(40, renderer.terminalWidth - 2);
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

  const traceViewportHeight = () => Math.max(1, renderer.terminalHeight - 2);

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

  const renderAll = () => {
    if (disposed) return;
    updatePaneVisibility();
    renderHeader();
    renderSandboxDetail();
    renderSessionsPane();
    renderTracePane();
    renderDetailPane();
    renderFooter();
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
    const prevExp = prevSel ? traceState.outputExpanded.get(prevSel) : undefined;
    traceState = applyTraceAction(traceState, action, traceViewportHeight());
    renderTracePane();
    if (hadStatus) renderFooter();

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
      if (!disposed && gen === searchGen) {
        searchHits = hits;
      }
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
    if (!key.ctrl && !key.meta && key.name === 'q') {
      options.onQuit();
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
    if (!progress.done) return;

    if (key.ctrl && !key.meta && key.name === 'k') {
      focus = 'sessions';
      searchInputMode = true;
      renderHeader();
      updatePaneBorders();
      renderSessionsPane();
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
