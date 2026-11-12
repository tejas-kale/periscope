#!/usr/bin/env node
import fs from 'node:fs';
import { formatHelp, parseCliArgs } from './args.ts';

function readPackageVersion(): string {
  const pkgUrl = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    process.stdout.write(`${formatHelp()}\n`);
    return;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`${parsed.message}\n\n${formatHelp()}\n`);
    process.exitCode = 1;
    return;
  }

  const [{ PeriscopeService }, { createOpenTuiAdapter, runTuiLifecycle }, { mountPeriscopeApp }] = await Promise.all([
    import('../core/service.ts'),
    import('../tui/adapter.ts'),
    import('../tui/app.ts'),
  ]);
  const service = new PeriscopeService({
    dbPath: parsed.options.dbPath,
    sandboxEnabled: parsed.options.sandbox,
  });
  const adapter = createOpenTuiAdapter();
  let handle: ReturnType<typeof mountPeriscopeApp> | undefined;
  let startupError: unknown = null;
  try {
    await runTuiLifecycle(adapter, (renderer, requestQuit) => {
      handle = mountPeriscopeApp(renderer, {
        service,
        theme: parsed.options.theme,
        initiallyIndexing: true,
        onQuit: requestQuit,
      });
      void service.start().then(
        () => handle?.refresh(),
        (err: unknown) => {
          startupError = err;
          requestQuit();
        },
      );
    });
  } finally {
    handle?.dispose();
    await service.stop();
  }
  if (startupError) throw startupError;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`periscope: ${message}\n`);
  process.exitCode = 1;
});
