import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

const sourceRoot = new URL('../src/', import.meta.url).href;

// Node's default loader refuses TypeScript inside node_modules. Strip only
// Periscope's own erasable TypeScript, using the same built-in parser as Node.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(sourceRoot) || !url.endsWith('.ts')) {
      return nextLoad(url, context);
    }
    return {
      format: 'module',
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { sourceUrl: url }),
      shortCircuit: true,
    };
  },
});
