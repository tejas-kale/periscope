import type { Agent, EventKind, Host } from '../../core/types.ts';

const KIND: Record<EventKind, { glyph: string; title: string }> = {
  turn: { glyph: '❯', title: 'User prompt' },
  reasoning: { glyph: '◌', title: 'Reasoning' },
  text: { glyph: '¶', title: 'Model text' },
  tool_call: { glyph: '⚙', title: 'Tool call' },
  tool_result: { glyph: '↳', title: 'Tool result' },
  error: { glyph: '✕', title: 'Error' },
  meta: { glyph: '·', title: 'Meta' },
};

export function KindIcon({ kind }: { kind: EventKind }) {
  const k = KIND[kind] ?? KIND.meta;
  return (
    <span className={`kind-icon k-${kind}`} title={k.title}>
      {k.glyph}
    </span>
  );
}

const AGENT: Record<Agent, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Agy' };

export function AgentBadge({ agent }: { agent: Agent }) {
  return <span className={`badge a-${agent}`}>{AGENT[agent]}</span>;
}

export function HostMarker({ host }: { host: Host }) {
  return (
    <span className={`host h-${host}`} title={host === 'sandbox' ? 'Ran in the Podman sandbox' : 'Ran on this Mac'}>
      {host === 'sandbox' ? '▣' : '⌂'}
    </span>
  );
}

export function LiveDot() {
  return <span className="live-dot" title="Live: changed in the last 30 s" />;
}
