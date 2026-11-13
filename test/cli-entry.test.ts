import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, '..', 'bin', 'periscope.mjs');

test('cli entrypoint: --help prints usage and exits 0', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI_PATH, '--help']);
  assert.equal(stderr, '');
  assert.match(stdout, /Usage: periscope/);
  assert.match(stdout, /--db <path>/);
  assert.match(stdout, /--no-sandbox/);
  assert.match(stdout, /--theme <mode>/);
});

test('cli entrypoint: --version prints package version and exits 0', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI_PATH, '--version']);
  assert.equal(stderr, '');
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('cli entrypoint: invalid flag prints error to stderr and exits non-zero', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI_PATH, '--unknown-flag']),
    (err: unknown) => {
      const e = err as { code?: number; stderr?: string };
      assert.equal(e.code, 1);
      assert.match(e.stderr ?? '', /Unknown option: --unknown-flag/);
      return true;
    },
  );
});
