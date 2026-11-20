import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';

const host = '127.0.0.1';
const listening = { host, port: 0, strictPort: true };
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export async function openBrowserTestServer({ development = false, playtest = false } = {}) {
  assert.ok(!(development && playtest), 'The player smoke test requires the production build in dist');
  const root = await realpath(projectRoot);
  let server;
  let cache;
  let outDir;
  async function close() {
    try {
      await server?.close();
    } finally {
      if (outDir) {
        const target = await realpath(outDir);
        assert.equal(dirname(target), cache, 'The regression output must be inside the private test directory');
        await rm(target, { recursive: true, maxRetries: 3 });
      }
    }
  }

  try {
    if (development) {
      server = await createServer({ root, mode: 'regression', server: listening });
      await server.listen();
    } else if (playtest) {
      server = await preview({ root, mode: 'production', build: { outDir: 'dist' }, preview: listening });
    } else {
      cache = join(root, '.estd-private');
      await mkdir(cache, { recursive: true });
      assert.equal(await realpath(cache), cache, 'The private test directory must resolve inside the project');
      outDir = await mkdtemp(join(cache, 'browser-regression-'));
      const config = { root, mode: 'regression', build: { outDir, emptyOutDir: false }, logLevel: 'warn' };
      await build(config);
      server = await preview({ ...config, preview: listening });
    }

    const address = server.httpServer?.address();
    assert.ok(address && typeof address === 'object', 'Vite did not bind a TCP port');
    return { url: `http://${host}:${address.port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
