import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer, extractSessionCookie, normalizePort } from '../src/loopback-server.mjs';

let server;
let baseUrl;

async function waitForCommand(base, path, predicate = () => true, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}${path}`);
    const body = await response.json();
    latest = body.command || null;
    if (latest && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for command at ${path}: ${JSON.stringify(latest)}`);
}

function fakePngHeader(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

before(async () => {
  server = createServer({ allowedOrigins: 'http://127.0.0.1:8787', preferencePath: null, attentionMode: 'adapter' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://${address.address}:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('health returns service metadata', async () => {
  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'hermes-webui-desktop-companion');
  assert.equal(body.name, 'Hermes WebUI Desktop Companion');
  assert.equal(body.version, '0.1.0');
  assert.deepEqual(body.sidecar, {
    type: 'loopback',
    health_path: '/health'
  });
  assert.equal(body.runtime.sidecar, 'running');
  assert.equal(body.runtime.native_host, 'not_registered');
  assert.equal(body.runtime.bridge, 'waiting');
  assert.equal(body.runtime.last_seen_at, null);
  assert.equal(body.runtime.webui_origin, null);
});

test('pet capabilities exposes pet pack contract metadata', async () => {
  const response = await fetch(`${baseUrl}/api/pet/capabilities`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.pet_pack_contract_version, 1);
  assert.equal(body.service, 'hermes-webui-desktop-companion');
  assert.deepEqual(body.pet_model, {
    user_facing_selection: 'pet_skin',
    pack_types: ['classic_skin', 'custom_display_pack'],
    default_pack_type: 'classic_skin',
    custom_display_packs: false
  });
  assert.equal(body.endpoints.attention, '/api/pet/attention');
  assert.equal(body.endpoints.snapshot, '/api/webui/snapshot');
  assert.equal(body.endpoints.skins, '/api/pet/skins');
  assert.equal(body.endpoints.capabilities, '/api/pet/capabilities');
  assert.deepEqual(body.attention.statuses, ['running', 'ready', 'action_required']);
  assert.deepEqual(body.attention.sources, ['webui-extension-snapshot', 'empty', 'stale', 'unloaded']);
  assert.equal(body.attention.stale_after_ms, 30_000);
  assert.equal(body.capabilities.read_attention, true);
  assert.equal(body.capabilities.read_snapshot, true);
  assert.equal(body.capabilities.read_skins, true);
  assert.equal(body.capabilities.open_session, true);
  assert.equal(body.capabilities.draft_reply, true);
  assert.equal(body.capabilities.direct_send, false);
  assert.equal(body.capabilities.inline_action_responses, false);
});

test('snapshot endpoint stores latest WebUI snapshot', async () => {
  const snapshot = {
    source: 'hermes-webui',
    version: 1,
    timestamp: new Date().toISOString(),
    page: { href: 'http://127.0.0.1:8787/', pathname: '/', visibilityState: 'visible' }
  };

  const post = await fetch(`${baseUrl}/api/webui/snapshot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:8787'
    },
    body: JSON.stringify(snapshot)
  });
  assert.equal(post.status, 200);

  const get = await fetch(`${baseUrl}/api/webui/snapshot`);
  const body = await get.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.snapshot, snapshot);

  const health = await fetch(`${baseUrl}/health`);
  const healthBody = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthBody.runtime.bridge, 'connected');
  assert.equal(healthBody.runtime.webui_origin, 'http://127.0.0.1:8787');
  assert.equal(healthBody.runtime.last_seen_at, Date.parse(snapshot.timestamp) / 1000);
});

test('pet attention is derived from latest WebUI snapshot', async () => {
  const snapshot = {
    source: 'hermes-webui',
    companion: {
      attention: [
        {
          session_id: 's1',
          status: 'running',
          title: 'Long task',
          text: 'Working',
          message_count: 3,
          updated_at: 100
        }
      ]
    }
  };

  await fetch(`${baseUrl}/api/webui/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot)
  });

  const response = await fetch(`${baseUrl}/api/pet/attention`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, 'webui-extension-snapshot');
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].session_id, 's1');
  assert.equal(body.sessions[0].status, 'running');
});

test('pet attention ignores unload snapshots', async () => {
  const snapshot = {
    source: 'hermes-webui',
    reason: 'unload',
    timestamp: new Date().toISOString(),
    companion: {
      attention: [
        {
          session_id: 's1',
          status: 'running',
          title: 'Old task',
          text: 'Still working'
        }
      ]
    }
  };

  await fetch(`${baseUrl}/api/webui/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot)
  });

  const response = await fetch(`${baseUrl}/api/pet/attention`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, 'unloaded');
  assert.deepEqual(body.sessions, []);
});

test('pet attention expires stale WebUI snapshots', async () => {
  const snapshot = {
    source: 'hermes-webui',
    reason: 'poll',
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    companion: {
      attention: [
        {
          session_id: 's1',
          status: 'running',
          title: 'Old task',
          text: 'Still working'
        }
      ]
    }
  };

  await fetch(`${baseUrl}/api/webui/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot)
  });

  const response = await fetch(`${baseUrl}/api/pet/attention`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, 'stale');
  assert.deepEqual(body.sessions, []);
});

test('pet open_session queues browser navigation command', async () => {
  const server = createServer({ attentionMode: 'adapter', preferencePath: null, focusExistingBrowserTab: false, openExternal: () => true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'hermes-webui',
        page: { href: 'http://127.0.0.1:8787/session/current' }
      })
    });

    const open = await fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123' })
    });
    const opened = await open.json();
    assert.equal(open.status, 200);
    assert.equal(opened.queued, true);
    assert.equal(opened.opened, true);
    assert.equal(opened.url, 'http://127.0.0.1:8787/session/abc123');

    const navigation = await fetch(`${base}/api/pet/navigation`);
    const body = await navigation.json();
    assert.equal(navigation.status, 200);
    assert.equal(body.command.session_id, 'abc123');

    const ack = await fetch(`${base}/api/pet/navigation_ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: body.command.id })
    });
    const ackBody = await ack.json();
    assert.equal(ack.status, 200);
    assert.equal(ackBody.ok, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet open_webui focuses the latest WebUI browser tab', async () => {
  const focusCalls = [];
  const server = createServer({
    attentionMode: 'adapter',
    preferencePath: null,
    focusExistingBrowserTab: (url, origin) => {
      focusCalls.push({ url, origin });
      return { focused: true, reused: true };
    },
    openExternal: () => {
      throw new Error('openExternal should not run when an existing tab is reused');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'hermes-webui',
        page: { href: 'http://127.0.0.1:8787/session/current?tab=chat#turn-1' }
      })
    });

    const open = await fetch(`${base}/api/pet/open_webui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const body = await open.json();

    assert.equal(open.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.focused, true);
    assert.equal(body.reused, true);
    assert.equal(body.opened, false);
    assert.equal(body.url, 'http://127.0.0.1:8787/session/current?tab=chat#turn-1');
    assert.deepEqual(focusCalls, [{
      url: 'http://127.0.0.1:8787/session/current?tab=chat#turn-1',
      origin: 'http://127.0.0.1:8787'
    }]);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('macOS Chrome tab focus does not reload an already focused target URL', async () => {
  const source = await readFile(new URL('../src/loopback-server.mjs', import.meta.url), 'utf8');

  assert.match(source, /function webuiSessionPath\(value\)/);
  assert.match(source, /on shouldNavigate\(currentUrl, targetUrl, targetSessionPath\)/);
  assert.match(source, /if isSameTargetSession\(currentUrl, targetSessionPath\) then return false/);
  assert.ok(source.includes('if firstChar is "?" then return true'));
  assert.ok(source.includes('if firstChar is "#" then return true'));
  assert.ok(source.includes('if firstChar is "/" then return true'));
  assert.match(source, /if my shouldNavigate\(activeUrl, targetUrl, targetSessionPath\) then\s+set URL of active tab of front window to targetUrl\s+end if/s);
  assert.match(source, /if my shouldNavigate\(currentUrl, targetUrl, targetSessionPath\) then\s+set URL of tab tabIndex of window w to targetUrl\s+end if/s);
});

test('pet open_webui falls back to the configured WebUI base without a snapshot', async () => {
  const focusCalls = [];
  const server = createServer({
    attentionMode: 'adapter',
    preferencePath: null,
    webuiBaseUrl: 'http://127.0.0.1:8788/',
    focusExistingBrowserTab: (url, origin) => {
      focusCalls.push({ url, origin });
      return { focused: true, reused: true };
    },
    openExternal: () => {
      throw new Error('openExternal should not run when an existing tab is reused');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    const open = await fetch(`${base}/api/pet/open_webui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const body = await open.json();

    assert.equal(open.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.focused, true);
    assert.equal(body.reused, true);
    assert.equal(body.opened, false);
    assert.equal(body.url, 'http://127.0.0.1:8788/');
    assert.deepEqual(focusCalls, [{
      url: 'http://127.0.0.1:8788/',
      origin: 'http://127.0.0.1:8788'
    }]);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet commands accept short Hermes session ids', async () => {
  const server = createServer({
    attentionMode: 'adapter',
    preferencePath: null,
    initialPreferences: { allow_inline_action_responses: true },
    focusExistingBrowserTab: false,
    openExternal: () => true
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'hermes-webui',
        page: { href: 'http://127.0.0.1:8787/session/current' }
      })
    });

    const open = await fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's1' })
    });
    const opened = await open.json();
    assert.equal(open.status, 200);
    assert.equal(opened.url, 'http://127.0.0.1:8787/session/s1');

    const actionPromise = fetch(`${base}/api/clarify/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's1', response: 'Use option A', clarify_id: 'clarify-1' })
    });
    const command = await waitForCommand(base, '/api/pet/actions', (item) => item.type === 'clarify.respond');
    assert.equal(command.session_id, 's1');
    assert.equal(command.body.session_id, 's1');

    await fetch(`${base}/api/pet/action_ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: command.id, ok: true, status: 200, result: { ok: true } })
    });
    const action = await actionPromise;
    assert.equal(action.status, 200);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet open_session focuses an existing WebUI browser tab', async () => {
  const focusCalls = [];
  const server = createServer({
    attentionMode: 'adapter',
    preferencePath: null,
    focusExistingBrowserTab: (url, origin) => {
      focusCalls.push({ url, origin });
      return { focused: true, reused: true };
    },
    openExternal: () => {
      throw new Error('openExternal should not run when an existing tab is reused');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'hermes-webui',
        page: { href: 'http://127.0.0.1:8787/session/current' }
      })
    });

    const open = await fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123' })
    });
    const body = await open.json();

    assert.equal(open.status, 200);
    assert.equal(body.queued, true);
    assert.equal(body.focused, true);
    assert.equal(body.reused, true);
    assert.equal(body.opened, false);
    assert.deepEqual(focusCalls, [{
      url: 'http://127.0.0.1:8787/session/abc123',
      origin: 'http://127.0.0.1:8787'
    }]);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet open_session waits for bridge ack when sending a quick reply draft', async () => {
  const server = createServer({
    attentionMode: 'adapter',
    preferencePath: null,
    initialPreferences: { allow_direct_send: true },
    focusExistingBrowserTab: () => ({ focused: true, reused: true }),
    openExternal: () => {
      throw new Error('openExternal should not run when an existing tab is reused');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'hermes-webui',
        page: { href: 'http://127.0.0.1:8787/session/current' }
      })
    });

    const openPromise = fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', draft: 'hello from pet', autosend: true })
    });

    const command = await waitForCommand(base, '/api/pet/navigation', (item) => item.session_id === 'abc123');
    assert.equal(command.session_id, 'abc123');
    assert.equal(command.draft, 'hello from pet');
    assert.equal(command.autosend, true);

    await fetch(`${base}/api/pet/navigation_ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: command.id })
    });

    const open = await openPromise;
    const opened = await open.json();
    assert.equal(open.status, 200);
    assert.equal(opened.consumed, true);
    // The bridge acked the navigation: no browser open/focus fallback ran,
    // so focused/reused/opened all stay false under the active-bridge-first
    // contract.
    assert.equal(opened.focused, false);
    assert.equal(opened.reused, false);
    assert.equal(opened.opened, false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet open_session downgrades autosend when direct send is disabled', async () => {
  const server = createServer({
    attentionMode: 'adapter',
    preferencePath: null,
    focusExistingBrowserTab: () => ({ focused: true, reused: true }),
    openExternal: () => {
      throw new Error('openExternal should not run when an existing tab is reused');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'hermes-webui',
        page: { href: 'http://127.0.0.1:8787/session/current' }
      })
    });

    const openPromise = fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', draft: 'hello from pet', autosend: true })
    });

    const command = await waitForCommand(base, '/api/pet/navigation', (item) => item.session_id === 'abc123');
    assert.equal(command.draft, 'hello from pet');
    assert.equal(command.autosend_requested, true);
    assert.equal(command.autosend, false);
    assert.equal(command.autosend_blocked, true);

    await fetch(`${base}/api/pet/navigation_ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: command.id })
    });

    const open = await openPromise;
    const opened = await open.json();
    assert.equal(open.status, 200);
    assert.equal(opened.command.autosend, false);
    assert.equal(opened.command.autosend_blocked, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet open_session reuses the active WebUI bridge tab before browser fallback', async () => {
  const openExternalCalls = [];
  const focusExistingBrowserTabCalls = [];
  const server = createServer({
    attentionMode: 'adapter',
    preferencePath: null,
    focusExistingBrowserTab: (url, origin) => {
      focusExistingBrowserTabCalls.push({ url, origin });
      return { focused: true, reused: true };
    },
    openExternal: (url) => {
      openExternalCalls.push(url);
      return true;
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'hermes-webui',
        page: { href: 'http://127.0.0.1:8787/session/current' }
      })
    });

    // Establish an active bridge: poll navigation once so
    // bridgeRecentlyPolled() is true when open_session fires.
    await fetch(`${base}/api/pet/navigation`);

    // Fire open_session (no draft). It must await the navigation ack first,
    // so it stays pending until the bridge acks the queued command.
    const openPromise = fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123' })
    });

    // While the request is pending, the active bridge polls the navigation
    // queue and acks the command — exactly the real adapter flow.
    const command = await waitForCommand(base, '/api/pet/navigation', (item) => item.session_id === 'abc123');
    assert.equal(command.session_id, 'abc123');
    assert.equal(command.url, 'http://127.0.0.1:8787/session/abc123');

    const ack = await fetch(`${base}/api/pet/navigation_ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: command.id })
    });
    const ackBody = await ack.json();
    assert.equal(ack.status, 200);
    assert.equal(ackBody.ok, true);

    const open = await openPromise;
    const opened = await open.json();

    // The bridge consumed the navigation: no browser open/focus fallback.
    assert.equal(open.status, 200);
    assert.equal(opened.ok, true);
    assert.equal(opened.consumed, true);
    assert.equal(opened.opened, false, 'must not open a browser tab when the bridge acks');
    assert.equal(opened.focused, false, 'must not focus a browser tab when the bridge acks');
    assert.equal(opened.reused, false, 'must not report a reused browser tab when the bridge acks');
    assert.equal(opened.queued, true);
    assert.equal(opened.url, 'http://127.0.0.1:8787/session/abc123');
    assert.equal(openExternalCalls.length, 0, 'openExternal spy must record zero calls when the bridge acks');
    assert.equal(focusExistingBrowserTabCalls.length, 0, 'focusExistingBrowserTab must not be called when the bridge acks');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet open_session falls back to openExternal when no fresh bridge has polled', async () => {
  const openExternalCalls = [];
  const focusExistingBrowserTabCalls = [];
  const server = createServer({
    attentionMode: 'adapter',
    preferencePath: null,
    focusExistingBrowserTab: false,
    openExternal: (url) => {
      openExternalCalls.push(url);
      return true;
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'hermes-webui',
        page: { href: 'http://127.0.0.1:8787/session/current' }
      })
    });

    // No GET /api/pet/navigation before open_session: bridgeRecentlyPolled()
    // is false, so a plain (no-draft) open_session must fall back to
    // openExternal instead of waiting on a bridge ack.
    const open = await fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123' })
    });
    const opened = await open.json();

    assert.equal(open.status, 200);
    assert.equal(opened.opened, true, 'must fall back to opening a browser tab when no fresh bridge exists');
    assert.equal(opened.url, 'http://127.0.0.1:8787/session/abc123');
    assert.deepEqual(openExternalCalls, ['http://127.0.0.1:8787/session/abc123']);
    assert.equal(focusExistingBrowserTabCalls.length, 0);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet approval and clarify responses are disabled until the user opts in', async () => {
  const server = createServer({ preferencePath: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    const approval = await fetch(`${base}/api/approval/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', choice: 'once', approval_id: 'approval-1' })
    });
    assert.equal(approval.status, 403);
    assert.equal((await approval.json()).error, 'inline_action_responses_disabled');

    const clarify = await fetch(`${base}/api/clarify/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', response: 'Use option A', clarify_id: 'clarify-1' })
    });
    assert.equal(clarify.status, 403);
    assert.equal((await clarify.json()).error, 'inline_action_responses_disabled');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet approval actions are executed by the WebUI action bridge', async () => {
  const server = createServer({
    preferencePath: null,
    initialPreferences: { allow_inline_action_responses: true }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://${address.address}:${address.port}`;
  try {
    const actionPromise = fetch(`${base}/api/approval/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', choice: 'once', approval_id: 'approval-1' })
    });

    const command = await waitForCommand(base, '/api/pet/actions', (item) => item.type === 'approval.respond');
    assert.equal(command.type, 'approval.respond');
    assert.deepEqual(command.body, {
      session_id: 'abc123',
      choice: 'once',
      approval_id: 'approval-1'
    });

    const ack = await fetch(`${base}/api/pet/action_ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: command.id, ok: true, status: 200, result: { ok: true } })
    });
    assert.equal(ack.status, 200);

    const response = await actionPromise;
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.queued, true);
    assert.equal(result.command.type, 'approval.respond');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet register and preference routes are owned by the sidecar', async () => {
  const register = await fetch(`${baseUrl}/api/pet/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pid: process.pid, base_url: 'http://127.0.0.1:17787' })
  });
  const registerBody = await register.json();
  assert.equal(register.status, 200);
  assert.equal(registerBody.ok, true);

  const health = await fetch(`${baseUrl}/health`);
  const healthBody = await health.json();
  assert.equal(healthBody.runtime.native_host, 'running');
  assert.ok(healthBody.runtime.native_host_registered_at > 0);

  const preferencePost = await fetch(`${baseUrl}/api/pet/preference`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: false,
      allow_direct_send: true,
      allow_inline_action_responses: true
    })
  });
  const preferencePostBody = await preferencePost.json();
  assert.equal(preferencePost.status, 200);
  assert.equal(preferencePostBody.ok, true);
  assert.equal(preferencePostBody.enabled, false);
  assert.equal(preferencePostBody.allow_direct_send, true);
  assert.equal(preferencePostBody.allow_inline_action_responses, true);

  const preferenceGet = await fetch(`${baseUrl}/api/pet/preference`);
  const preferenceGetBody = await preferenceGet.json();
  assert.equal(preferenceGet.status, 200);
  assert.equal(preferenceGetBody.ok, true);
  assert.equal(preferenceGetBody.enabled, false);
  assert.equal(preferenceGetBody.allow_direct_send, true);
  assert.equal(preferenceGetBody.allow_inline_action_responses, true);

  const capabilities = await fetch(`${baseUrl}/api/pet/capabilities`);
  const capabilitiesBody = await capabilities.json();
  assert.equal(capabilities.status, 200);
  assert.equal(capabilitiesBody.capabilities.direct_send, true);
  assert.equal(capabilitiesBody.capabilities.inline_action_responses, true);
});

test('desktop pet pages and assets are served by loopback', async () => {
  const pet = await fetch(`${baseUrl}/pet`);
  assert.equal(pet.status, 200);
  assert.match(await pet.text(), /petStage/);

  const bubbles = await fetch(`${baseUrl}/pet/bubbles`);
  assert.equal(bubbles.status, 200);
  assert.match(await bubbles.text(), /petBubbles/);

  const gallery = await fetch(`${baseUrl}/pet/gallery`);
  assert.equal(gallery.status, 200);
  assert.match(await gallery.text(), /Pet Gallery/);

  const script = await fetch(`${baseUrl}/desktop-pet/pet.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') || '', /javascript/);

  const sprite = await fetch(`${baseUrl}/extensions/pets/keeper/spritesheet.webp`);
  assert.equal(sprite.status, 200);
  assert.equal(sprite.headers.get('content-type'), 'image/webp');
});

test('pet skins include installed Hermes pets and serve their spritesheets', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'hermes-pets-'));
  const petsRoot = path.join(tmpRoot, 'pets');
  await mkdir(path.join(petsRoot, 'panam'), { recursive: true });
  await mkdir(path.join(petsRoot, 'legacy'), { recursive: true });
  await mkdir(path.join(petsRoot, 'unsupported'), { recursive: true });

  try {
    await writeFile(path.join(petsRoot, 'panam', 'pet.json'), JSON.stringify({
      id: 'panam',
      displayName: 'Panam',
      description: 'Hermes-installed Petdex skin.',
      spritesheetPath: 'spritesheet.webp'
    }));
    await copyFile(
      new URL('../extension/pets/keeper/spritesheet.webp', import.meta.url),
      path.join(petsRoot, 'panam', 'spritesheet.webp')
    );

    await writeFile(path.join(petsRoot, 'legacy', 'pet.json'), JSON.stringify({
      id: 'legacy',
      displayName: 'Legacy Pet',
      description: 'Legacy 9x8 pet sheet.',
      spritesheetPath: 'spritesheet.png'
    }));
    await writeFile(path.join(petsRoot, 'legacy', 'spritesheet.png'), fakePngHeader(1728, 1664));

    await writeFile(path.join(petsRoot, 'unsupported', 'pet.json'), JSON.stringify({
      id: 'unsupported',
      displayName: 'Unsupported Pet',
      description: 'Non-atlas dimensions should not be offered.',
      spritesheetPath: 'spritesheet.png'
    }));
    await writeFile(path.join(petsRoot, 'unsupported', 'spritesheet.png'), fakePngHeader(1024, 1024));

    const localServer = createServer({ preferencePath: null, hermesPetsDir: petsRoot });
    await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address();
    const url = `http://${address.address}:${address.port}`;
    try {
      const response = await fetch(`${url}/api/pet/skins`);
      const body = await response.json();
      assert.equal(response.status, 200);

      const byId = new Map(body.skins.map((skin) => [skin.id, skin]));
      assert.ok(byId.has('keeper'));
      assert.ok(byId.has('hermes-panam'));
      assert.ok(byId.has('hermes-legacy'));
      assert.equal(byId.has('hermes-unsupported'), false);

      const keeper = byId.get('keeper');
      assert.equal(keeper.displayName, 'May');
      assert.equal(keeper.spritesheetUrl, '/extensions/pets/keeper/spritesheet.webp');
      assert.equal(keeper.layout.columns, 8);
      assert.equal(keeper.layout.rows, 9);
      assert.equal(keeper.layout.states.find((item) => item.name === 'idle').frames, 6);
      assert.equal(keeper.layout.states.find((item) => item.name === 'running-right').frames, 8);
      assert.equal(keeper.layout.states.find((item) => item.name === 'review').row, 8);

      const panam = byId.get('hermes-panam');
      assert.equal(panam.displayName, 'Panam');
      assert.equal(panam.source, 'hermes-pets');
      assert.equal(panam.hermesPetSlug, 'panam');
      assert.equal(panam.spritesheetUrl, '/api/pet/hermes-pets/panam/spritesheet.webp');
      assert.equal(panam.layout.columns, 8);
      assert.equal(panam.layout.rows, 9);
      assert.equal(panam.layout.states.find((item) => item.name === 'running-right').frames, 8);
      assert.equal(panam.layout.states.find((item) => item.name === 'running-left').frames, 8);
      assert.equal(panam.layout.states.find((item) => item.name === 'waving').frames, 4);
      assert.equal(panam.layout.states.find((item) => item.name === 'jumping').frames, 5);
      assert.equal(panam.layout.states.find((item) => item.name === 'failed').frames, 8);
      assert.equal(panam.layout.states.find((item) => item.name === 'running').row, 7);

      const legacy = byId.get('hermes-legacy');
      assert.equal(legacy.spritesheetUrl, '/api/pet/hermes-pets/legacy/spritesheet.png');
      assert.equal(legacy.layout.columns, 9);
      assert.equal(legacy.layout.rows, 8);
      assert.equal(legacy.layout.states.find((item) => item.name === 'running-right').row, 2);
      assert.equal(legacy.layout.states.find((item) => item.name === 'running-left').row, 2);
      assert.equal(legacy.layout.states.find((item) => item.name === 'review').row, 4);
      assert.equal(legacy.layout.states.find((item) => item.name === 'waiting').row, 0);

      const sprite = await fetch(`${url}${panam.spritesheetUrl}`);
      assert.equal(sprite.status, 200);
      assert.equal(sprite.headers.get('content-type'), 'image/webp');
      assert.ok((await sprite.arrayBuffer()).byteLength > 1024);
    } finally {
      await new Promise((resolve, reject) => {
        localServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('pet gallery searches Petdex manifest and installs through Hermes CLI', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'hermes-pet-gallery-'));
  const petsRoot = path.join(tmpRoot, 'pets');
  const commands = [];

  async function installFixture(slug) {
    await mkdir(path.join(petsRoot, slug), { recursive: true });
    await writeFile(path.join(petsRoot, slug, 'pet.json'), JSON.stringify({
      id: slug,
      displayName: 'Panam',
      description: 'Installed from the gallery.',
      spritesheetPath: 'spritesheet.webp'
    }));
    await copyFile(
      new URL('../extension/pets/keeper/spritesheet.webp', import.meta.url),
      path.join(petsRoot, slug, 'spritesheet.webp')
    );
  }

  try {
    const localServer = createServer({
      preferencePath: null,
      hermesPetsDir: petsRoot,
      petGalleryPets: [
        {
          slug: 'panam',
          displayName: 'Panam',
          kind: 'character',
          submittedBy: 'tester',
          spritesheetUrl: 'https://assets.petdex.dev/pets/panam/sprite.webp'
        },
        {
          slug: 'other-pet',
          displayName: 'Other Pet',
          kind: 'object',
          submittedBy: 'tester'
        }
      ],
      runHermesPetsCommand: async (args) => {
        commands.push(args);
        if (args[0] === 'pets' && args[1] === 'install') {
          await installFixture(args[args.length - 1]);
          return { stdout: 'installed', stderr: '' };
        }
        if (args[0] === 'pets' && args[1] === 'remove') {
          await rm(path.join(petsRoot, args[2]), { recursive: true, force: true });
          return { stdout: 'removed', stderr: '' };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      }
    });
    await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address();
    const url = `http://${address.address}:${address.port}`;
    try {
      const gallery = await fetch(`${url}/api/pet/gallery?q=panam`);
      const galleryBody = await gallery.json();
      assert.equal(gallery.status, 200);
      assert.equal(galleryBody.total, 1);
      assert.equal(galleryBody.pets[0].slug, 'panam');
      assert.equal(galleryBody.pets[0].installed, false);

      const install = await fetch(`${url}/api/pet/gallery/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'panam' })
      });
      const installBody = await install.json();
      assert.equal(install.status, 200);
      assert.equal(installBody.ok, true);
      assert.equal(installBody.installed, true);
      assert.equal(installBody.supported, true);
      assert.equal(installBody.skin.id, 'hermes-panam');
      assert.deepEqual(commands[0], ['pets', 'install', 'panam']);

      const installedGallery = await fetch(`${url}/api/pet/gallery?q=panam`);
      const installedBody = await installedGallery.json();
      assert.equal(installedBody.pets[0].installed, true);
      assert.equal(installedBody.pets[0].compatibility, 'supported');
      assert.equal(installedBody.pets[0].skinId, 'hermes-panam');

      const remove = await fetch(`${url}/api/pet/gallery/remove`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'panam' })
      });
      const removeBody = await remove.json();
      assert.equal(remove.status, 200);
      assert.equal(removeBody.ok, true);
      assert.equal(removeBody.removed, true);
      assert.deepEqual(commands[1], ['pets', 'remove', 'panam']);
    } finally {
      await new Promise((resolve, reject) => {
        localServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('pet gallery uses Petdex live search and falls back when the Hermes CLI manifest lags', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'hermes-petdex-live-'));
  const petsRoot = path.join(tmpRoot, 'pets');
  const sprite = await readFile(new URL('../extension/pets/keeper/spritesheet.webp', import.meta.url));
  const commands = [];
  const requests = [];
  const mayPetJson = {
    id: 'may',
    displayName: 'May',
    description: 'A calm black-and-white chibi companion for careful work, quiet reviews, and evidence-first decisions.',
    spritesheetPath: 'spritesheet.webp'
  };

  const fakeFetch = async (requestUrl) => {
    const url = new URL(String(requestUrl));
    requests.push(url.toString());
    if (url.pathname === '/api/pets/search') {
      assert.equal(url.searchParams.get('q'), 'may');
      return Response.json({
        pets: [
          {
            slug: 'may',
            displayName: 'May',
            description: mayPetJson.description,
            kind: 'character',
            submittedBy: { name: 'franksong2702' },
            spritesheetPath: 'https://assets.petdex.dev/pets/may-8b80a31dc19f/sprite.webp',
            zipUrl: 'https://assets.petdex.dev/pets/may-8b80a31dc19f/zip.zip'
          }
        ],
        total: 1
      });
    }
    if (url.pathname === '/api/install-pet/may') {
      return Response.json({
        ok: true,
        pet: {
          slug: 'may',
          displayName: 'May',
          petJsonUrl: 'https://assets.petdex.dev/pets/may-8b80a31dc19f/petjson.json',
          spritesheetUrl: 'https://assets.petdex.dev/pets/may-8b80a31dc19f/sprite.webp',
          spriteExt: 'webp'
        }
      });
    }
    if (url.pathname === '/pets/may-8b80a31dc19f/petjson.json') {
      return Response.json(mayPetJson);
    }
    if (url.pathname === '/pets/may-8b80a31dc19f/sprite.webp') {
      return new Response(sprite, { headers: { 'content-type': 'image/webp' } });
    }
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  };

  try {
    const localServer = createServer({
      preferencePath: null,
      hermesPetsDir: petsRoot,
      disablePetGalleryManifestFallback: true,
      fetch: fakeFetch,
      runHermesPetsCommand: async (args) => {
        commands.push(args);
        throw Object.assign(new Error("install failed: pet 'may' is not in the petdex manifest"), {
          statusCode: 502,
          code: 'hermes_cli_failed',
          stderr: "✗ install failed: pet 'may' is not in the petdex manifest"
        });
      }
    });
    await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address();
    const url = `http://${address.address}:${address.port}`;
    try {
      const gallery = await fetch(`${url}/api/pet/gallery?q=may`);
      const galleryBody = await gallery.json();
      assert.equal(gallery.status, 200);
      assert.equal(galleryBody.source, 'petdex-live');
      assert.equal(galleryBody.total, 1);
      assert.equal(galleryBody.pets[0].slug, 'may');
      assert.equal(galleryBody.pets[0].submittedBy, 'franksong2702');
      assert.equal(galleryBody.pets[0].installed, false);

      const preview = await fetch(`${url}/api/pet/gallery/preview/may`);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('content-type'), 'image/webp');
      assert.ok((await preview.arrayBuffer()).byteLength > 1024);

      const install = await fetch(`${url}/api/pet/gallery/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'may' })
      });
      const installBody = await install.json();
      assert.equal(install.status, 200);
      assert.equal(installBody.ok, true);
      assert.equal(installBody.installed, true);
      assert.equal(installBody.supported, true);
      assert.equal(installBody.installSource, 'petdex-direct');
      assert.equal(installBody.skin.id, 'hermes-may');
      assert.equal(installBody.skin.displayName, 'May');
      assert.deepEqual(commands[0], ['pets', 'install', 'may']);

      const installedManifest = JSON.parse(await readFile(path.join(petsRoot, 'may', 'pet.json'), 'utf8'));
      assert.equal(installedManifest.id, 'may');
      assert.equal(installedManifest.spritesheetPath, 'spritesheet.webp');
      assert.ok(requests.some((value) => value.includes('/api/pets/search?')));
      assert.ok(requests.some((value) => value.endsWith('/api/install-pet/may')));
    } finally {
      await new Promise((resolve, reject) => {
        localServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('pet skin selection can be set from the manager page', async () => {
  const localServer = createServer({ preferencePath: null });
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const address = localServer.address();
  const url = `http://${address.address}:${address.port}`;
  try {
    const initial = await fetch(`${url}/api/pet/skin_selection`);
    const initialBody = await initial.json();
    assert.equal(initial.status, 200);
    assert.equal(initialBody.ok, true);
    assert.equal(initialBody.changed, false);
    assert.equal(initialBody.skin_id, null);

    const selected = await fetch(`${url}/api/pet/skin_selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skin_id: 'keeper' })
    });
    const selectedBody = await selected.json();
    assert.equal(selected.status, 200);
    assert.equal(selectedBody.ok, true);
    assert.equal(selectedBody.changed, true);
    assert.equal(selectedBody.skin_id, 'keeper');

    const unchanged = await fetch(`${url}/api/pet/skin_selection?since=${selectedBody.updated_at_ms}`);
    const unchangedBody = await unchanged.json();
    assert.equal(unchanged.status, 200);
    assert.equal(unchangedBody.changed, false);
    assert.equal(unchangedBody.skin_id, null);

    const changed = await fetch(`${url}/api/pet/skin_selection?since=0`);
    const changedBody = await changed.json();
    assert.equal(changed.status, 200);
    assert.equal(changedBody.changed, true);
    assert.equal(changedBody.skin_id, 'keeper');

    const missing = await fetch(`${url}/api/pet/skin_selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skin_id: 'missing-skin' })
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve, reject) => {
      localServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet skin selection persists across sidecar restarts', async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'hermes-companion-skin-selection-'));
  const skinSelectionPath = path.join(tmpRoot, 'skin-selection.json');
  let localServer = createServer({ preferencePath: null, skinSelectionPath });
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = localServer.address();
    const url = `http://${address.address}:${address.port}`;
    const selected = await fetch(`${url}/api/pet/skin_selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skin_id: 'keeper' })
    });
    const selectedBody = await selected.json();
    assert.equal(selected.status, 200);
    assert.equal(selectedBody.skin_id, 'keeper');
    assert.deepEqual(JSON.parse(await readFile(skinSelectionPath, 'utf8')), {
      skin_id: 'keeper',
      updated_at_ms: selectedBody.updated_at_ms,
      updated_at: selectedBody.updated_at
    });
    await new Promise((resolve, reject) => localServer.close((error) => (error ? reject(error) : resolve())));

    localServer = createServer({ preferencePath: null, skinSelectionPath });
    await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const restartedAddress = localServer.address();
    const restored = await fetch(`http://${restartedAddress.address}:${restartedAddress.port}/api/pet/skin_selection?since=0`);
    const restoredBody = await restored.json();
    assert.equal(restored.status, 200);
    assert.equal(restoredBody.changed, true);
    assert.equal(restoredBody.skin_id, 'keeper');
    assert.equal(restoredBody.updated_at_ms, selectedBody.updated_at_ms);
  } finally {
    await new Promise((resolve) => localServer.close(() => resolve()));
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test('desktop pet devUrl supports HEAD probes', async () => {
  const response = await fetch(`${baseUrl}/pet`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
});

test('default CORS allows loopback WebUI ports', async () => {
  const localServer = createServer({ preferencePath: null });
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const address = localServer.address();
  const url = `http://${address.address}:${address.port}`;
  try {
    const response = await fetch(`${url}/api/webui/snapshot`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:8791',
        'access-control-request-method': 'POST'
      }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8791');
  } finally {
    await new Promise((resolve, reject) => {
      localServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('invalid JSON is rejected', async () => {
  const response = await fetch(`${baseUrl}/api/webui/snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });

  assert.equal(response.status, 400);
});

// --- Server-attention mode: the sidecar pulls directly from the remote
// WebUI instead of the adapter snapshot channel. Tests drive the poll loop
// deterministically via server.tickServerAttention() with mocked
// loginWebui/webuiFetch — no real network or timers involved.

async function startAttentionServer(overrides = {}) {
  const server = createServer({
    attentionMode: 'server',
    attentionAutoStart: false,
    webuiRemoteBase: 'https://hermes.meruru.ccwu.cc',
    webuiPassword: 'test-password',
    preferencePath: null,
    focusExistingBrowserTab: false,
    openExternal: () => true,
    ...overrides
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function closeAttentionServer(server) {
  if (server) server.stopServerAttention();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('server attention mode logs in, polls the remote WebUI, and serves attention', async () => {
  const loginCalls = [];
  const fetchPaths = [];
  const server = await startAttentionServer({
    loginWebui: async () => {
      loginCalls.push(1);
      return { ok: true, cookieHeader: 'hermes_session=token.sig' };
    },
    webuiFetch: async (path) => {
      fetchPaths.push(path);
      if (path === '/api/sessions') {
        return {
          status: 200,
          ok: true,
          data: { sessions: [{ session_id: 'srv-run', title: 'Remote task', is_streaming: true, message_count: 2, updated_at: 200, last_message_at: 200 }] }
        };
      }
      return { status: 404, ok: false, data: null };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();

    const attention = await fetch(`${base}/api/pet/attention`);
    const body = await attention.json();
    assert.equal(attention.status, 200);
    assert.equal(body.source, 'server-poll');
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].session_id, 'srv-run');
    assert.equal(body.sessions[0].status, 'running');
    assert.equal(body.sessions[0].title, 'Remote task');

    const connection = await fetch(`${base}/api/pet/connection`);
    const connBody = await connection.json();
    assert.equal(connection.status, 200);
    assert.deepEqual({ mode: connBody.mode, state: connBody.state }, { mode: 'server', state: 'online' });
    assert.ok(fetchPaths.includes('/api/sessions'));
    assert.equal(loginCalls.length, 1);
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode marks sessions ready after a running to idle transition', async () => {
  let running = true;
  const sid = 'srv-transition';
  const server = await startAttentionServer({
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiFetch: async (path) => {
      if (path === '/api/sessions') {
        const sessions = running
          ? [{ session_id: sid, title: 'Transition task', is_streaming: true, message_count: 1, updated_at: 500 }]
          : [{ session_id: sid, title: 'Transition task', message_count: 2, updated_at: 900, last_message_at: 900 }];
        return { status: 200, ok: true, data: { sessions } };
      }
      return { status: 404, ok: false, data: null };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();
    let body = await (await fetch(`${base}/api/pet/attention`)).json();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].status, 'running');

    running = false;
    await server.tickServerAttention();
    body = await (await fetch(`${base}/api/pet/attention`)).json();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].status, 'ready');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode surfaces action_required from the session attention field', async () => {
  const server = await startAttentionServer({
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiFetch: async (path) => {
      if (path === '/api/sessions') {
        return {
          status: 200,
          ok: true,
          data: { sessions: [{
            session_id: 'srv-act',
            title: 'Needs approval',
            attention: { status: 'action_required', kind: 'approval', approval_id: 'ap-1', description: 'Approve network call' },
            message_count: 3,
            updated_at: 700
          }] }
        };
      }
      if (path.startsWith('/api/approval/pending')) {
        return {
          status: 200,
          ok: true,
          data: { pending: { kind: 'approval', approval_id: 'ap-1', description: 'Approve network call' }, pending_count: 1 }
        };
      }
      return { status: 404, ok: false, data: null };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();
    const body = await (await fetch(`${base}/api/pet/attention`)).json();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].status, 'action_required');
    assert.equal(body.sessions[0].action_required_type, 'approval');
    assert.equal(body.sessions[0].action_required_approval_id, 'ap-1');
    assert.equal(body.sessions[0].action_required_choices.length, 0);
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode goes offline after 3 network failures and recovers', async () => {
  let failMode = 'network';
  const server = await startAttentionServer({
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiFetch: async (path) => {
      if (failMode === 'network') throw new Error('network unreachable');
      if (failMode === 'auth') return { status: 401, ok: false, data: null };
      if (path === '/api/sessions') return { status: 200, ok: true, data: { sessions: [] } };
      return { status: 404, ok: false, data: null };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const state = async () => (await (await fetch(`${base}/api/pet/connection`)).json()).state;

    // Failures 1-2 keep the state online; the 3rd consecutive failure flips
    // to offline (the VPS-grade "~9s" worst case at the 2.5s poll interval).
    await server.tickServerAttention();
    await server.tickServerAttention();
    assert.equal(await state(), 'online');
    await server.tickServerAttention();
    assert.equal(await state(), 'offline');

    // A successful tick resets the counter and returns to online.
    failMode = 'ok';
    await server.tickServerAttention();
    assert.equal(await state(), 'online');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode enters auth_error with a 30s backoff on 401', async () => {
  let loginCalls = 0;
  let fetchCalls = 0;
  const server = await startAttentionServer({
    loginWebui: async () => {
      loginCalls += 1;
      return { ok: true, cookieHeader: 'hermes_session=token.sig' };
    },
    webuiFetch: async () => {
      fetchCalls += 1;
      return { status: 401, ok: false, data: null };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();
    let conn = await (await fetch(`${base}/api/pet/connection`)).json();
    assert.equal(conn.state, 'auth_error');
    assert.equal(fetchCalls, 1);

    // Backoff: consecutive ticks must not re-login or re-fetch until the
    // 30s window expires.
    await server.tickServerAttention();
    assert.equal(loginCalls, 1);
    assert.equal(fetchCalls, 1);
    conn = await (await fetch(`${base}/api/pet/connection`)).json();
    assert.equal(conn.state, 'auth_error');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode enters auth_error with a 30s backoff on 429 (throttled)', async () => {
  let loginCalls = 0;
  let fetchCalls = 0;
  const server = await startAttentionServer({
    loginWebui: async () => {
      loginCalls += 1;
      return { ok: true, cookieHeader: 'hermes_session=token.sig' };
    },
    webuiFetch: async () => {
      fetchCalls += 1;
      return { status: 429, ok: false, data: null };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();
    let conn = await (await fetch(`${base}/api/pet/connection`)).json();
    assert.equal(conn.state, 'auth_error');
    assert.equal(fetchCalls, 1);

    // Backoff: consecutive ticks must not re-login or re-fetch until the
    // 30s window expires.
    await server.tickServerAttention();
    assert.equal(loginCalls, 1);
    assert.equal(fetchCalls, 1);
    conn = await (await fetch(`${base}/api/pet/connection`)).json();
    assert.equal(conn.state, 'auth_error');
  } finally {
    await closeAttentionServer(server);
  }
});

test('extractSessionCookie parses hermes_session from getSetCookie(), tolerating dotted values and extra cookies', () => {
  const fakeResponse = {
    headers: {
      getSetCookie: () => [
        'other=ignored; Path=/',
        'hermes_session=abc123.def456; Path=/; HttpOnly; SameSite=Lax',
        'third=value; Path=/'
      ]
    }
  };
  const fakeLegacyResponse = {
    headers: {
      get: (key) => (key === 'set-cookie' ? 'hermes_session=legacy.token; Path=/' : null)
    }
  };
  assert.equal(extractSessionCookie(fakeResponse, 'hermes_session'), 'abc123.def456');
  assert.equal(extractSessionCookie(fakeResponse, 'missing'), '');
  assert.equal(extractSessionCookie(fakeLegacyResponse, 'hermes_session'), 'legacy.token');
});

test('server attention mode backs off after a failed password login', async () => {
  let loginCalls = 0;
  const server = await startAttentionServer({
    loginWebui: async () => {
      loginCalls += 1;
      return { ok: false, reason: 'auth' };
    },
    webuiFetch: async () => {
      throw new Error('must not be called');
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();
    let conn = await (await fetch(`${base}/api/pet/connection`)).json();
    assert.equal(conn.state, 'auth_error');

    await server.tickServerAttention();
    assert.equal(loginCalls, 1);
    conn = await (await fetch(`${base}/api/pet/connection`)).json();
    assert.equal(conn.state, 'auth_error');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode consumes viewed_counts and completion_unread from the pet query', async () => {
  const sessions = [{ session_id: 'srv-done', title: 'Done', message_count: 5, updated_at: 1000, last_message_at: 1000 }];
  const server = await startAttentionServer({
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiFetch: async (path) => {
      if (path === '/api/sessions') return { status: 200, ok: true, data: { sessions } };
      return { status: 404, ok: false, data: null };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const unread = { 'srv-done': { completed_at: Date.now() - 1000, message_count: 5 } };
    const query = `viewed_counts=${encodeURIComponent('{}')}&completion_unread=${encodeURIComponent(JSON.stringify(unread))}`;
    await fetch(`${base}/api/pet/attention?${query}`);

    await server.tickServerAttention();
    const body = await (await fetch(`${base}/api/pet/attention`)).json();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].session_id, 'srv-done');
    assert.equal(body.sessions[0].status, 'ready');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode ignores adapter snapshots but rejects invalid JSON', async () => {
  const server = await startAttentionServer({
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiFetch: async () => ({ status: 200, ok: true, data: { sessions: [] } })
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();

    const valid = await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'hermes-webui', companion: { attention: [{ session_id: 'x', status: 'running' }] } })
    });
    assert.equal(valid.status, 200);

    // The adapter snapshot must NOT be served back in server mode: the poll
    // loop owns latestSnapshot (a poll snapshot, not the adapter one).
    const get = await fetch(`${base}/api/webui/snapshot`);
    const getBody = await get.json();
    assert.equal(getBody.snapshot && getBody.snapshot.reason, 'poll');
    assert.deepEqual(getBody.snapshot.companion.attention, []);

    const invalid = await fetch(`${base}/api/webui/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    assert.equal(invalid.status, 400);
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode falls back to the remote base for pet session navigation', async () => {
  const server = await startAttentionServer({
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiFetch: async () => ({ status: 200, ok: true, data: { sessions: [] } })
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();
    const open = await fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123' })
    });
    const body = await open.json();
    assert.equal(open.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.url, 'https://hermes.meruru.ccwu.cc/session/abc123');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode without a remote base falls back to adapter without polling', async () => {
  let loginCalls = 0;
  const server = await startAttentionServer({
    webuiRemoteBase: '',
    loginWebui: async () => {
      loginCalls += 1;
      return { ok: true, cookieHeader: 'hermes_session=token.sig' };
    },
    webuiFetch: async () => {
      throw new Error('must not be called');
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();
    const conn = await (await fetch(`${base}/api/pet/connection`)).json();
    assert.equal(conn.mode, 'adapter');
    assert.equal(conn.state, 'adapter');
    assert.equal(loginCalls, 0);
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode without a password falls back to adapter mode', async () => {
  let loginCalls = 0;
  const server = await startAttentionServer({
    webuiPassword: '',
    loginWebui: async () => {
      loginCalls += 1;
      return { ok: true, cookieHeader: 'hermes_session=token.sig' };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();
    const conn = await (await fetch(`${base}/api/pet/connection`)).json();
    assert.deepEqual({ mode: conn.mode, state: conn.state }, { mode: 'adapter', state: 'adapter' });
    assert.equal(loginCalls, 0);
  } finally {
    await closeAttentionServer(server);
  }
});
test('normalizes configured ports', () => {
  assert.equal(normalizePort('17787'), 17787);
  assert.throws(() => normalizePort('99999'), /Invalid port/);
});

// --- server-attention action path (approval/clarify direct VPS call) ---
// These exercise handleQueuedPetAction in server mode: the sidecar calls the
// VPS API directly via webuiPost instead of queuing for the adapter bridge.

test('server attention mode forwards approval.respond to the VPS and passes the response through', async () => {
  const postCalls = [];
  const server = await startAttentionServer({
    initialPreferences: { allow_inline_action_responses: true },
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiPost: async (path, body) => {
      postCalls.push({ path, body });
      return { ok: true, status: 200, json: { ok: true, approval_id: 'ap-1', resolved: true }, needRelogin: false };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const response = await fetch(`${base}/api/approval/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', choice: 'once', approval_id: 'ap-1' })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.server_executed, true);
    assert.equal(body.resolved, true);
    assert.equal(body.approval_id, 'ap-1');
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].path, '/api/approval/respond');
    assert.equal(postCalls[0].body.choice, 'once');
    assert.equal(postCalls[0].body.approval_id, 'ap-1');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode forwards clarify.respond to the VPS clarify endpoint', async () => {
  const postCalls = [];
  const server = await startAttentionServer({
    initialPreferences: { allow_inline_action_responses: true },
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiPost: async (path, body) => {
      postCalls.push({ path, body });
      return { ok: true, status: 200, json: { ok: true, clarify_id: 'cl-1' }, needRelogin: false };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const response = await fetch(`${base}/api/clarify/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', response: 'Use option A', clarify_id: 'cl-1' })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.server_executed, true);
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].path, '/api/clarify/respond');
    assert.equal(postCalls[0].body.response, 'Use option A');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode rejects approval/clarify with 403 when the inline switch is off', async () => {
  const server = await startAttentionServer({
    initialPreferences: { allow_inline_action_responses: false },
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiPost: async () => { throw new Error('webuiPost must not be called when the switch is off'); }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const approval = await fetch(`${base}/api/approval/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', choice: 'once', approval_id: 'ap-1' })
    });
    assert.equal(approval.status, 403);
    assert.equal((await approval.json()).error, 'inline_action_responses_disabled');

    const clarify = await fetch(`${base}/api/clarify/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', response: 'A', clarify_id: 'cl-1' })
    });
    assert.equal(clarify.status, 403);
    assert.equal((await clarify.json()).error, 'inline_action_responses_disabled');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode re-logins and retries once on a 401 from the VPS', async () => {
  let postCalls = 0;
  let loginCalls = 0;
  const server = await startAttentionServer({
    initialPreferences: { allow_inline_action_responses: true },
    loginWebui: async () => {
      loginCalls += 1;
      return { ok: true, cookieHeader: 'hermes_session=token.sig' };
    },
    webuiPost: async () => {
      postCalls += 1;
      // First call: 401 (cookie expired). Second call (after re-login): 200.
      if (postCalls === 1) return { ok: false, status: 401, json: { ok: false, error: 'unauthorized' }, needRelogin: true };
      return { ok: true, status: 200, json: { ok: true, resolved: true }, needRelogin: false };
    }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const response = await fetch(`${base}/api/approval/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', choice: 'once', approval_id: 'ap-1' })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.server_executed, true);
    assert.equal(body.resolved, true);
    assert.equal(postCalls, 2);
    assert.equal(loginCalls, 1);
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode passes a VPS 400 through without wrapping it as 502', async () => {
  const server = await startAttentionServer({
    initialPreferences: { allow_inline_action_responses: true },
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiPost: async () => ({
      ok: false,
      status: 400,
      json: { ok: false, error: 'invalid_choice', choices: ['once', 'always'] },
      needRelogin: false
    })
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const response = await fetch(`${base}/api/approval/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', choice: 'bogus', approval_id: 'ap-1' })
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.server_executed, true);
    assert.equal(body.error, 'invalid_choice');
    assert.deepEqual(body.choices, ['once', 'always']);
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode returns 502 on a network failure reaching the VPS', async () => {
  const server = await startAttentionServer({
    initialPreferences: { allow_inline_action_responses: true },
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiPost: async () => { throw new Error('network unreachable'); }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const response = await fetch(`${base}/api/approval/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', choice: 'once', approval_id: 'ap-1' })
    });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.server_executed, true);
    assert.equal(body.error, 'webui_action_network');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode open_session opens the browser and returns opened=true without waiting for ack', async () => {
  const server = await startAttentionServer({
    initialPreferences: { allow_inline_action_responses: true, allow_direct_send: true },
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    webuiFetch: async () => ({ status: 200, ok: true, data: { sessions: [] } }),
    openExternal: (url) => { server.__openedUrl = url; return true; }
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    await server.tickServerAttention();
    // A draft + autosend payload: in server mode these are silently dropped
    // (P2-1); the browser still opens to the session URL and no ack is waited.
    const open = await fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', draft: 'hello', autosend: true })
    });
    const body = await open.json();
    assert.equal(open.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.opened, true);
    assert.equal(body.server_executed, true);
    assert.equal(body.consumed, false);
    assert.equal(body.queued, false);
    assert.equal(body.url, 'https://hermes.meruru.ccwu.cc/session/abc123');
    assert.equal(server.__openedUrl, 'https://hermes.meruru.ccwu.cc/session/abc123');
  } finally {
    await closeAttentionServer(server);
  }
});

test('server attention mode open_session still opens the browser when no cookie has been logged in yet', async () => {
  const server = await startAttentionServer({
    initialPreferences: { allow_inline_action_responses: true },
    loginWebui: async () => ({ ok: true, cookieHeader: 'hermes_session=token.sig' }),
    openExternal: () => true
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    // No tickServerAttention: latestSnapshot stays null, but queuePetSessionNavigation
    // falls back to serverAttentionConfig.baseUrl.origin (server mode).
    const open = await fetch(`${base}/api/pet/open_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'xyz789' })
    });
    const body = await open.json();
    assert.equal(open.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.opened, true);
    assert.equal(body.server_executed, true);
    assert.equal(body.url, 'https://hermes.meruru.ccwu.cc/session/xyz789');
  } finally {
    await closeAttentionServer(server);
  }
});

test('adapter mode approval/respond still queues for the bridge (no server-mode regression)', async () => {
  const server = createServer({
    attentionMode: 'adapter',
    preferencePath: null,
    initialPreferences: { allow_inline_action_responses: true }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const actionPromise = fetch(`${base}/api/approval/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc123', choice: 'once', approval_id: 'ap-1' })
    });
    const command = await waitForCommand(base, '/api/pet/actions', (item) => item.type === 'approval.respond');
    assert.equal(command.type, 'approval.respond');
    const ack = await fetch(`${base}/api/pet/action_ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: command.id, ok: true, status: 200, result: { ok: true } })
    });
    assert.equal(ack.status, 200);
    const response = await actionPromise;
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.queued, true);
    assert.equal(result.server_executed, undefined);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
