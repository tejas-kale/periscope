import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSandboxDetail, formatSandboxStatus } from '../src/view-model/sandbox-status.ts';

test('sandbox-status: formats status labels for online, offline, error, disabled, unknown', () => {
  assert.equal(formatSandboxStatus({ state: 'online' }), 'sandbox: online');
  assert.equal(formatSandboxStatus({ state: 'offline', message: 'podman not found' }), 'sandbox: offline [S]');
  assert.equal(formatSandboxStatus({ state: 'offline' }), 'sandbox: offline');
  assert.equal(formatSandboxStatus({ state: 'error', message: 'invalid reference' }), 'sandbox: error [S]');
  assert.equal(formatSandboxStatus({ state: 'disabled', message: 'disabled by --no-sandbox' }), 'sandbox: disabled');
  assert.equal(formatSandboxStatus({ state: 'unknown' }), 'sandbox: unknown');
});

test('sandbox-status: formats inspectable detail for error and non-error states', () => {
  assert.deepEqual(formatSandboxDetail({ state: 'error', message: 'Error: invalid reference format' }), {
    title: 'Podman failed while polling the sandbox volumes:',
    body: 'Error: invalid reference format',
  });
  assert.deepEqual(formatSandboxDetail({ state: 'offline', message: 'Cannot connect to Podman' }), {
    title: 'Sandbox (offline):',
    body: 'Cannot connect to Podman',
  });
  assert.deepEqual(formatSandboxDetail({ state: 'online' }), {
    title: 'Sandbox (online):',
    body: 'Sandbox polling is active.',
  });
});
