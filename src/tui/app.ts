import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import type { IndexProgress } from '../core/service.ts';
import type { ChangeNotice, PeriscopeApi, SandboxState, SessionRow } from '../core/types.ts';
import type { ThemeOption } from '../cli/args.ts';
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

export interface PeriscopeAppService extends Pick<PeriscopeApi, 'listSessions' | 'sandboxStatus' | 'onChange' | 'onSandbox'> {
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

interface Palette {
  headerBg: string;
  headerFg: string;
  groupFg: string;
  cursorBg: string;
  selectedBg: string;
  fg: string;
  mutedFg: string;
  liveFg: string;
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
    footerBg: '#1f2937',
  };
}

function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 1) return text.slice(0, Math.max(0, maxLen));
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function formatRowText(item: SessionListItem, now: number, maxWidth: number): string {
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

/** Mount the Periscope terminal UI (indexing progress + grouped session list pane). */
export function mountPeriscopeApp(renderer: CliRenderer, options: PeriscopeAppOptions): PeriscopeAppHandle {
  const resolvedTheme: 'dark' | 'light' =
    options.theme === 'auto' ? (renderer.themeMode ?? 'dark') : options.theme;
  const palette = getPalette(resolvedTheme);
  const clock = options.clock ?? Date.now;

  let sessions: SessionRow[] = [];
  let listState: SessionListState = createSessionListState([]);
  let sandbox: SandboxState = { state: 'unknown' };
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
  });
  const headerText = new TextRenderable(renderer, {
    content: '',
    fg: palette.headerFg,
  });
  headerBar.add(headerText);

  const listScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: '100%',
    scrollY: true,
    scrollX: false,
  });

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
  root.add(listScroll);
  root.add(footerBar);
  renderer.root.add(root);

  let rowNodes: BoxRenderable[] = [];

  const clearRows = () => {
    for (const node of rowNodes) {
      listScroll.remove(node);
      node.destroyRecursively();
    }
    rowNodes = [];
  };

  const renderHeader = () => {
    headerText.content = ` Periscope  |  theme: ${resolvedTheme}  |  sandbox: ${sandbox.state}  |  q quit`;
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

  const renderBody = () => {
    clearRows();
    if (!progress.done) {
      const box = new BoxRenderable(renderer, { height: 1, width: '100%' });
      const label = progress.total > 0
        ? ` Indexing sessions... ${progress.indexed} / ${progress.total}`
        : ' Indexing sessions...';
      box.add(new TextRenderable(renderer, { content: label, fg: palette.fg }));
      listScroll.add(box);
      rowNodes.push(box);
      return;
    }

    if (sessions.length === 0) {
      const box = new BoxRenderable(renderer, { height: 1, width: '100%' });
      box.add(new TextRenderable(renderer, { content: ' No sessions found.', fg: palette.mutedFg }));
      listScroll.add(box);
      rowNodes.push(box);
      return;
    }

    const now = clock();
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
          dispatch({ type: 'clickItem', key: item.key });
        },
      });
      const rowText = new TextRenderable(renderer, {
        content: formatRowText(item, now, Math.max(40, renderer.terminalWidth - 2)),
        fg,
      });
      rowBox.add(rowText);
      listScroll.add(rowBox);
      rowNodes.push(rowBox);
    }
  };

  const renderAll = () => {
    if (disposed) return;
    renderHeader();
    renderBody();
    renderFooter();
  };

  const dispatch = (action: Parameters<typeof applySessionListAction>[2]) => {
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

    renderBody();
    renderFooter();

    if (
      nextState.selectedSessionId &&
      (nextState.selectedSessionId !== prevSelected ||
        action.type === 'activate' ||
        action.type === 'quickOpen' ||
        action.type === 'clickItem')
    ) {
      const selected = sessions.find((s) => s.id === nextState.selectedSessionId);
      if (selected) options.onSelectSession?.(selected);
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
    if (!progress.done) return;
    const action = keyToSessionListAction(key);
    if (action) dispatch(action);
  };

  renderer.keyInput.on('keypress', onKeypress);

  const offProgress = options.service.onProgress?.((p) => {
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
      clearRows();
      renderer.root.remove(root);
      root.destroyRecursively();
    },
  };
}
