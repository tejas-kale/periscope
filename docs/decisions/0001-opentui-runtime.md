# 0001: OpenTUI Imperative API & `node --test` Runner

## Decision 1: `@opentui/core` imperative API over `@opentui/solid`

We use `@opentui/core` (pinned to `0.8.4`) with its imperative renderable API rather than `@opentui/solid`.

**Verified findings (Node v22.23.4):**
- `@opentui/solid/preload` (`scripts/preload.node.js`) and `@opentui/solid/bun-plugin` (`scripts/solid-plugin.node.js`) both throw `"Bun-only and is not available in Node.js"` when imported under Node.
- `@opentui/core` runs directly under Node's native TypeScript type-stripping (`erasableSyntaxOnly: true`) with no JSX/Babel transform or custom loader.
- `@opentui/solid` has been removed from `package.json`.

## Decision 2: `node --test` with `@opentui/core/testing`

We keep `node --test` as the test runner rather than switching to Bun's test runner.

**Verified findings (Node v22.23.4):**
- `@opentui/core/testing` (`createTestRenderer`, `createMockKeys`, etc.) imports cleanly as standard ESM under `node --test` with no `bun:test` dependency.
- `@opentui/core@0.8.4` declares `engines.node >= 26.4.0` because its native FFI backend loads `node:ffi`. On Node `v22.23.4` (this container), `node:ffi` is unavailable and `createCliRenderer` / `createTestRenderer` throw `OpenTUI native FFI is not available for this runtime yet`.
- Therefore, `test/tui-shell.test.ts` runs the `createTestRenderer` integration test when `node:ffi` is present (Node >= 26.4.0) and skips it with an explicit runtime version message on Node < 26.4.0, while testing `TuiAdapter`, capability detection, `q` / `Ctrl+C` quit handling, and uncaught-error terminal restoration via the adapter seam on all Node versions.

## Decision 3: Install without a TypeScript build

The npm package ships `bin/` and `src/`. Its JavaScript launcher registers a
synchronous load hook that uses Node's `stripTypeScriptTypes` only for Periscope's
own source files. This is necessary because Node's default TypeScript loader
rejects files under `node_modules`, including globally installed packages.

Git installs must not depend on a `prepare` build: npm can inherit global-install
settings into its Git preparation subprocess, leaving the clone without local
build dependencies and linking the global package to a deleted temporary clone.
TypeScript and Node type definitions remain development-only typechecking tools.
There is no install-time compilation or generated `dist/` artifact to maintain.

Run `sh scripts/test-git-install.sh` on Node >=26.4.0 to verify the committed Git
package installs into a fresh temporary prefix, runs help/version, and loads the
UI with its runtime dependencies. This installation check is separate from CI,
which only runs tests.
