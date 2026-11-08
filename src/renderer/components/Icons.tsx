import type { Agent, EventKind, Host } from '../../core/types.ts';

/** 16px line icons (Lucide-style paths), coloured by `currentColor`. */
const PATHS: Record<EventKind, React.ReactNode> = {
  // a person: the user's prompt
  turn: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </>
  ),
  // a light bulb: thinking
  reasoning: (
    <>
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
    </>
  ),
  // a speech bubble: the model's reply
  text: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" />,
  // a wrench: a tool call
  tool_call: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />,
  // an arrow out of a box: a result
  tool_result: (
    <>
      <path d="M4 4v9a3 3 0 0 0 3 3h13" />
      <path d="m15 11 5 5-5 5" />
    </>
  ),
  // a crossed circle: an error
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-6 6M9 9l6 6" />
    </>
  ),
  // an info circle: everything else
  meta: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
};

const TITLE: Record<EventKind, string> = {
  turn: 'User prompt',
  reasoning: 'Reasoning',
  text: 'Model text',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  error: 'Error',
  meta: 'Meta',
};

export function KindIcon({ kind }: { kind: EventKind }) {
  return (
    <span className={`kind-icon k-${kind}`} title={TITLE[kind] ?? 'Meta'}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {PATHS[kind] ?? PATHS.meta}
      </svg>
    </span>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chevron ${open ? 'open' : ''}`} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

const AGENT: Record<Agent, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Agy' };

export function AgentBadge({ agent }: { agent: Agent }) {
  return <span className={`badge a-${agent}`}>{AGENT[agent]}</span>;
}

export function HostMarker({ host }: { host: Host }) {
  return (
    <span className={`badge h-${host}`} title={host === 'sandbox' ? 'Ran in the Podman sandbox' : 'Ran on this Mac'}>
      {host === 'sandbox' ? 'Sandbox' : 'Mac'}
    </span>
  );
}

export function LiveDot() {
  return <span className="live-dot" title="Live: changed in the last 30 s" />;
}
