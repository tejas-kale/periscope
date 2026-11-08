import { contextBridge, ipcRenderer } from 'electron';
import type { ChangeNotice, PeriscopeApi, SandboxState } from '../core/types.ts';

const api: PeriscopeApi = {
  listSessions: (f) => ipcRenderer.invoke('periscope:listSessions', f),
  getEvents: (id, since) => ipcRenderer.invoke('periscope:getEvents', id, since),
  getRaw: (id) => ipcRenderer.invoke('periscope:getRaw', id),
  search: (q, f) => ipcRenderer.invoke('periscope:search', q, f),
  sandboxStatus: () => ipcRenderer.invoke('periscope:sandboxStatus'),
  readImage: (p) => ipcRenderer.invoke('periscope:readImage', p),
  onChange: (cb) => {
    const h = (_e: unknown, n: ChangeNotice) => cb(n);
    ipcRenderer.on('periscope:change', h);
    return () => ipcRenderer.removeListener('periscope:change', h);
  },
  onSandbox: (cb) => {
    const h = (_e: unknown, s: SandboxState) => cb(s);
    ipcRenderer.on('periscope:sandbox', h);
    return () => ipcRenderer.removeListener('periscope:sandbox', h);
  },
};

contextBridge.exposeInMainWorld('periscope', api);
