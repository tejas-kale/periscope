import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs, formatHelp } from '../src/cli/args.ts';

test('cli args: defaults when no flags passed', () => {
  const res = parseCliArgs([]);
  assert.deepEqual(res, {
    kind: 'run',
    options: {
      dbPath: undefined,
      sandbox: undefined,
      theme: 'auto',
    },
  });
});

test('cli args: --help and -h return help', () => {
  assert.equal(parseCliArgs(['--help']).kind, 'help');
  assert.equal(parseCliArgs(['-h']).kind, 'help');
  assert.match(formatHelp(), /--db/);
  assert.match(formatHelp(), /--no-sandbox/);
  assert.match(formatHelp(), /--theme/);
});

test('cli args: --version and -v return version', () => {
  assert.equal(parseCliArgs(['--version']).kind, 'version');
  assert.equal(parseCliArgs(['-v']).kind, 'version');
});

test('cli args: parses --db, --sandbox/--no-sandbox, and --theme', () => {
  assert.deepEqual(
    parseCliArgs(['--db', '/tmp/p.db', '--no-sandbox', '--theme', 'dark']),
    {
      kind: 'run',
      options: {
        dbPath: '/tmp/p.db',
        sandbox: false,
        theme: 'dark',
      },
    },
  );

  assert.deepEqual(
    parseCliArgs(['--db=/tmp/other.db', '--sandbox', '--theme=light']),
    {
      kind: 'run',
      options: {
        dbPath: '/tmp/other.db',
        sandbox: true,
        theme: 'light',
      },
    },
  );
});

test('cli args: rejects unknown flags, missing values, and invalid theme', () => {
  assert.equal(parseCliArgs(['--bogus']).kind, 'error');
  assert.equal(parseCliArgs(['--db']).kind, 'error');
  assert.equal(parseCliArgs(['--theme']).kind, 'error');
  assert.equal(parseCliArgs(['--theme', 'sepia']).kind, 'error');
});
