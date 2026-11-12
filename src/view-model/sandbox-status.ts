import type { SandboxState } from '../core/types.ts';

export interface SandboxDetail {
  title: string;
  body: string;
}

/** Format the compact sandbox status label for the status/header line. */
export function formatSandboxStatus(sandbox: SandboxState): string {
  const hasDetail = (sandbox.state === 'error' || sandbox.state === 'offline') && Boolean(sandbox.message);
  return hasDetail ? `sandbox: ${sandbox.state} [S]` : `sandbox: ${sandbox.state}`;
}

/** Format the inspectable sandbox detail message shown on user request. */
export function formatSandboxDetail(sandbox: SandboxState): SandboxDetail {
  if (sandbox.state === 'error') {
    return {
      title: 'Podman failed while polling the sandbox volumes:',
      body: sandbox.message || 'Unknown sandbox error.',
    };
  }
  const fallback =
    sandbox.state === 'online'
      ? 'Sandbox polling is active.'
      : sandbox.state === 'offline'
        ? 'Podman machine is not running.'
        : sandbox.state === 'disabled'
          ? 'Sandbox polling is disabled.'
          : 'Waiting for initial sandbox poll.';
  return {
    title: `Sandbox (${sandbox.state}):`,
    body: sandbox.message || fallback,
  };
}
