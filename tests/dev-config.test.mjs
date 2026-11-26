import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfigFromFile } from 'vite';

async function configFor(managed) {
  const previous = process.env.SITES_MANAGED_LINUX_CONTAINER;
  try {
    if (managed) process.env.SITES_MANAGED_LINUX_CONTAINER = '1';
    else delete process.env.SITES_MANAGED_LINUX_CONTAINER;
    return (await loadConfigFromFile({ command: 'serve', mode: 'development' }, 'vite.config.ts')).config;
  } finally {
    if (previous === undefined) delete process.env.SITES_MANAGED_LINUX_CONTAINER;
    else process.env.SITES_MANAGED_LINUX_CONTAINER = previous;
  }
}

test('local development binds loopback and retains Vite host protection', async () => {
  const config = await configFor(false);
  assert.equal(config.server.host, '127.0.0.1');
  assert.notEqual(config.server.allowedHosts, true);
  assert.equal(config.server.proxy['/api'].target, 'http://127.0.0.1:3001');
});

test('managed frontend preview does not proxy the tokenless local API', async () => {
  const config = await configFor(true);
  assert.equal(config.server.proxy?.['/api'], undefined);
});
