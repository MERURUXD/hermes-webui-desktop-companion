import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer, normalizePort } from '../src/loopback-server.mjs';

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
  server = createServer({ allowedOrigins: 'http://127.0.0.1:8787', preferencePath: null });
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
  const server = createServer({ preferencePath: null, focusExistingBrowserTab: false, openExternal: () => true });
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
    assert.equal(opened.focused, true);
    assert.equal(opened.reused, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('pet open_session downgrades autosend when direct send is disabled', async () => {
  const server = createServer({
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

test('normalizes configured ports', () => {
  assert.equal(normalizePort('17787'), 17787);
  assert.throws(() => normalizePort('99999'), /Invalid port/);
});
