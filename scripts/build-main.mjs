// Bundle the Electron main process and preload script to CommonJS in dist-electron/.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, logLevel: 'info' };
await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist-electron/main.cjs',
  external: ['electron', 'better-sqlite3'],
  // import.meta.dirname has no CJS equivalent in esbuild's output; map it to __dirname.
  define: { 'import.meta.dirname': '__dirname' },
});
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist-electron/preload.cjs', external: ['electron'] });
