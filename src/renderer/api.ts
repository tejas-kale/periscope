import type { PeriscopeApi } from '../core/types.ts';

declare global {
  interface Window {
    periscope: PeriscopeApi;
  }
}

export const api = (): PeriscopeApi => window.periscope;
