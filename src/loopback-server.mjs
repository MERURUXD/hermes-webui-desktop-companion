import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SERVICE_NAME = 'hermes-webui-desktop-companion';
export const DISPLAY_NAME = 'Hermes WebUI Desktop Companion';
export const VERSION = '0.1.0';
export const PET_PACK_CONTRACT_VERSION = 1;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_WEB_ROOT = path.join(PROJECT_ROOT, 'desktop-pet', 'web');
const EXTENSION_ROOT = path.join(PROJECT_ROOT, 'extension');
const PETS_ROOT = path.join(EXTENSION_ROOT, 'pets');
const PET_NAVIGATION_TTL_MS = 60_000;
const PET_NAVIGATION_MAX_COMMANDS = 20;
const PET_BRIDGE_POLL_FRESH_MS = 4_000;
const PET_ACTION_TTL_MS = 60_000;
const PET_ACTION_MAX_COMMANDS = 50;
const PET_ACTION_WAIT_MS = 7_000;
const PET_SNAPSHOT_ATTENTION_TTL_MS = 30_000;
const PET_FRAME_WIDTH = 192;
const PET_FRAME_HEIGHT = 208;
const PET_FRAMES_PER_STATE = 6;
const PET_GALLERY_MANIFEST_URL = 'https://petdex.dev/api/manifest';
const PET_GALLERY_SEARCH_URL = 'https://petdex.dev/api/pets/search';
const PET_GALLERY_INSTALL_URL = 'https://petdex.dev/api/install-pet';
const PET_GALLERY_CACHE_MS = 5 * 60 * 1000;
const PET_GALLERY_DEFAULT_LIMIT = 12;
const PET_GALLERY_MAX_LIMIT = 48;
const CODEX_PET_ROWS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
const CODEX_PET_FRAMES_BY_STATE = {
  idle: 6,
  'running-right': 8,
  'running-left': 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6
};
const LEGACY_PET_ROW_BY_STATE = {
  idle: 0,
  'running-right': 2,
  'running-left': 2,
  waving: 1,
  jumping: 5,
  failed: 3,
  waiting: 0,
  running: 2,
  review: 4
};
const DEFAULT_WEBUI_BASE_URL = 'http://127.0.0.1:8787/';
const DEFAULT_PREFERENCES = Object.freeze({
  enabled: true,
  allow_direct_send: false,
  allow_inline_action_responses: false
});
let petGalleryCache = null;

// ---------------------------------------------------------------------------
// Server-attention mode (feat/server-attention): the sidecar pulls attention
// straight from the remote WebUI (HERMES_COMPANION_WEBUI_REMOTE_BASE) instead
// of relying on adapter snapshots, so bubbles keep working with the WebUI tab
// fully closed. buildAttention + its pure helpers below are ported from the
// desktop-companion WebUI adapter (extension/companion-adapter.js) with the
// runtime/storage bridges replaced by sidecar equivalents:
//   webuiRuntimeState()          -> serverWebuiRuntimeState() (empty runtime)
//   storageState()               -> module-level petStateStore (in-memory)
//   fetchSessionDetail           -> webuiFetch (per-server) with adapter params
//   fetchActionDetail            -> webuiFetch (per-server)
//   isLocallyRunningSession      -> row fields only (no in-page runtime)
//   mergeSessionRows             -> server sessions only (runtime is empty)
//   markActionContinuation       -> not ported on purpose: no caller in the
//                                   sidecar, so recentActionContinuations
//                                   stays empty (documented degradation)
// ---------------------------------------------------------------------------
const ATTENTION_CONFIG = Object.freeze({
  maxAttention: 8,
  recentCompletionMs: 30 * 60 * 1000,
  completionUnreadMaxAgeMs: 30 * 60 * 1000,
  actionContinuationMs: 2 * 60 * 1000
});
const WEBUI_FETCH_TIMEOUT_MS = 5_000;
const WEBUI_AUTH_BACKOFF_MS = 30_000;
const WEBUI_NETWORK_FAILURE_LIMIT = 3;
const WEBUI_DEFAULT_POLL_INTERVAL_MS = 2_500;
const WEBUI_SESSION_COOKIE_NAME = 'hermes_session';

// Module-level adapter state + in-memory pet state store (equivalent to the
// adapter's localStorage-backed storageState). One sidecar process serves one
// pet, so process-wide state matches the adapter's page-wide state. Each
// createServer instance passes its own instance-level state into
// serverBuildAttention so parallel servers (tests) never share bookkeeping.
function createAttentionState() {
  return {
    observedRunning: new Map(),
    recentCompletions: new Map(),
    recentActionContinuations: new Map()
  };
}
function createPetStateStore() {
  return { viewedCounts: {}, completionUnread: {} };
}
const petStateStore = createPetStateStore();
const attentionState = createAttentionState();

function serverWebuiRuntimeState() {
  return { appState: null, allSessions: [], inflight: {} };
}

// Resolve the remote-WebUI config used by server attention mode:
//   base      - HERMES_COMPANION_WEBUI_REMOTE_BASE, trimmed, no trailing slash
//   baseUrl   - parsed URL, or null when missing/invalid
//   password  - HERMES_COMPANION_WEBUI_PASSWORD (options override env)
//   mode      - 'server' (default) or 'adapter' (env/option overrides)
function webuiConfig(options = {}) {
  const rawBase = String(
    options.webuiRemoteBase || process.env.HERMES_COMPANION_WEBUI_REMOTE_BASE || ''
  ).trim();
  let baseUrl = null;
  if (rawBase) {
    try {
      const parsed = new URL(rawBase);
      if (['http:', 'https:'].includes(parsed.protocol) && parsed.hostname) baseUrl = parsed;
    } catch (_) {
      baseUrl = null;
    }
  }
  const base = baseUrl ? baseUrl.href.replace(/\/+$/, '') : '';
  const password = options.webuiPassword !== undefined
    ? String(options.webuiPassword ?? '')
    : String(process.env.HERMES_COMPANION_WEBUI_PASSWORD || '');
  const mode = String(options.attentionMode || process.env.HERMES_COMPANION_ATTENTION_MODE || 'server')
    .trim()
    .toLowerCase() === 'adapter'
    ? 'adapter'
    : 'server';
  return { base, baseUrl, password, mode };
}

export function extractSessionCookie(response, name) {
  let setCookies = [];
  if (typeof response.headers.getSetCookie === 'function') {
    setCookies = response.headers.getSetCookie();
  } else {
    const raw = response.headers.get('set-cookie');
    setCookies = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  }
  for (const raw of setCookies) {
    const cookie = String(raw || '').split(';')[0].trim(); // strip attributes only
    const eq = cookie.indexOf('=');
    if (eq > 0 && cookie.slice(0, eq) === name) {
      try {
        return decodeURIComponent(cookie.slice(eq + 1));
      } catch (_) {
        return cookie.slice(eq + 1);
      }
    }
  }
  return '';
}

// Default login: POST {base}/api/auth/login with the WebUI password and
// capture the hermes_session cookie (token.sig). 401/429 count as auth
// failures (server-side login throttling is 5 tries/60s/IP).
async function loginWebuiRemote(cfg) {
  if (!cfg || !cfg.baseUrl || !cfg.password) return { ok: false, reason: 'auth' };
  try {
    const response = await fetch(`${cfg.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: cfg.password }),
      signal: AbortSignal.timeout(WEBUI_FETCH_TIMEOUT_MS)
    });
    if (response.status === 200) {
      const value = extractSessionCookie(response, WEBUI_SESSION_COOKIE_NAME);
      if (value) return { ok: true, cookieHeader: `${WEBUI_SESSION_COOKIE_NAME}=${value}` };
      return { ok: false, reason: 'auth' };
    }
    return {
      ok: false,
      reason: response.status === 401 || response.status === 429 ? 'auth' : 'network'
    };
  } catch (_) {
    return { ok: false, reason: 'network' };
  }
}

// Default GET fetcher: cookie + 5s hard timeout (blackholed routes must not
// stall the offline card forever). Returns { status, ok, data }.
async function fetchViaWebuiBase(path, ctx = {}) {
  const response = await fetch(`${ctx.base || ''}${path}`, {
    method: 'GET',
    headers: ctx.cookieHeader ? { cookie: ctx.cookieHeader } : {},
    signal: AbortSignal.timeout(ctx.timeoutMs || WEBUI_FETCH_TIMEOUT_MS)
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, data };
}

// Default POST fetcher: same cookie jar + timeout as fetchViaWebuiBase, but
// method=POST with a JSON body and content-type header. Returns
// { status, ok, json } (json null when the body is not valid JSON). Used by
// the server-attention action path (approval/clarify.respond) to call the
// VPS API directly without the WebUI adapter bridge. A 401 response sets
// needRelogin=true so the caller can re-login and retry once.
async function postViaWebuiBase(path, body, ctx = {}) {
  const response = await fetch(`${ctx.base || ''}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ctx.cookieHeader ? { cookie: ctx.cookieHeader } : {})
    },
    body: JSON.stringify(body && typeof body === 'object' ? body : {}),
    signal: AbortSignal.timeout(ctx.timeoutMs || WEBUI_FETCH_TIMEOUT_MS)
  });
  const json = await response.json().catch(() => null);
  return {
    status: response.status,
    ok: response.ok,
    json,
    needRelogin: response.status === 401
  };
}

// --- helpers ported from companion-adapter.js (unchanged unless noted) ---
function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function timestampToMs(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 10_000_000_000 ? raw * 1000 : raw;
}

function sessionId(session) {
  return String(session && session.session_id || '').trim();
}

function isRunningSession(session) {
  return Boolean(
    session &&
    (
      session.is_streaming ||
      session.active_stream_id ||
      session.pending_user_message ||
      session.has_pending_user_message
    )
  );
}

// Sidecar port: no in-page runtime, so "locally running" is row fields only.
function isLocallyRunningSession(session) {
  return isRunningSession(session);
}

// Ported verbatim for fidelity; no caller in the sidecar today.
function baselineFromActionBody(body) {
  const source = body && typeof body === 'object' ? body : {};
  return {
    messageCount: Number(
      source.baseline_message_count ||
      source.baselineMessageCount ||
      source.message_count ||
      source.messageCount ||
      0
    ),
    lastMessageAt: Number(
      source.baseline_last_message_at ||
      source.baselineLastMessageAt ||
      source.last_message_at ||
      source.lastMessageAt ||
      0
    )
  };
}

// Ported verbatim for fidelity; no caller in the sidecar today.
function actionContinuationBaseline(sid, runtime = serverWebuiRuntimeState(), body = null) {
  const target = cleanText(sid);
  const bodyBaseline = baselineFromActionBody(body);
  let messageCount = Number(bodyBaseline.messageCount || 0);
  let lastMessageAt = Number(bodyBaseline.lastMessageAt || 0);
  const visit = (session) => {
    if (!session || sessionId(session) !== target) return;
    messageCount = Math.max(messageCount, Number(session.message_count || 0));
    lastMessageAt = Math.max(lastMessageAt, Number(session.last_message_at || session.updated_at || 0));
  };
  // Sidecar port: no page-side session list; runtime.allSessions is empty.
  for (const session of runtime.allSessions || []) visit(session);
  visit(runtime.appState && runtime.appState.session);
  return { messageCount, lastMessageAt };
}

function actionContinuationItem(session) {
  const sid = sessionId(session);
  if (!sid) return null;
  const item = attentionState.recentActionContinuations.get(sid);
  if (!item) return null;
  if (Date.now() - Number(item.startedAt || 0) > ATTENTION_CONFIG.actionContinuationMs) {
    attentionState.recentActionContinuations.delete(sid);
    return null;
  }
  return Number(session && session.message_count || 0) > 0 ? item : null;
}

function isActionContinuationCompleted(session, item = actionContinuationItem(session)) {
  if (!item) return false;
  const messageCount = Number(session && session.message_count || 0);
  const lastMessageAt = Number(session && (session.last_message_at || session.updated_at) || 0);
  const baseCount = Number(item.messageCount || 0);
  const baseAt = Number(item.lastMessageAt || 0);
  return Boolean(
    (baseCount > 0 && messageCount > baseCount) ||
    (baseAt > 0 && lastMessageAt > baseAt)
  );
}

function isActionContinuationSession(session) {
  const item = actionContinuationItem(session);
  return Boolean(item && !isActionContinuationCompleted(session, item));
}

// Ported verbatim for fidelity; no caller in the sidecar today.
function hasVisibleLiveState(inflight) {
  if (!inflight || typeof inflight !== 'object') return false;
  if (cleanText(inflight.lastAssistantText || inflight.last_assistant_text)) return true;
  if (cleanText(inflight.lastReasoningText || inflight.last_reasoning_text)) return true;
  const scene = inflight.anchorActivityScene || inflight.anchor_activity_scene;
  if (scene && Array.isArray(scene.activity_rows) && scene.activity_rows.length) return true;
  if (Array.isArray(inflight.messages)) {
    return inflight.messages.some((message) => {
      if (!message || message.role !== 'assistant') return false;
      return Boolean(messageContentText(message));
    });
  }
  return false;
}

function explicitAttention(session) {
  const attention = session && session.attention && typeof session.attention === 'object' ? session.attention : {};
  const status = cleanText(attention.status || attention.state || attention.kind || session.action_required_type || '').toLowerCase();
  if (session && session.action_required) return 'action_required';
  if (['action_required', 'approval', 'clarify'].includes(status)) return 'action_required';
  if (['running', 'ready'].includes(status)) return status;
  return '';
}

function sessionAttention(session) {
  const attention = session && session.attention && typeof session.attention === 'object' ? session.attention : {};
  return attention && typeof attention === 'object' ? attention : {};
}

function actionRequiredType(session, actionDetail = null) {
  const attention = sessionAttention(session);
  const pending = actionDetail && actionDetail.pending && typeof actionDetail.pending === 'object' ? actionDetail.pending : {};
  const raw = cleanText(
    session && session.action_required_type ||
    pending.kind ||
    attention.kind ||
    attention.type ||
    ''
  ).toLowerCase();
  if (raw === 'approval' || raw === 'clarify') return raw;
  return '';
}

function actionRequiredChoices(session, actionDetail = null) {
  const attention = sessionAttention(session);
  const pending = actionDetail && actionDetail.pending && typeof actionDetail.pending === 'object' ? actionDetail.pending : {};
  const candidates = [
    session && session.action_required_choices,
    pending.choices_offered,
    pending.choices,
    attention.choices_offered,
    attention.choices
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length) {
      return value.map((choice) => String(choice || '')).filter((choice) => choice.trim());
    }
  }
  return [];
}

function actionRequiredMetadata(session, actionDetail = null) {
  const sid = sessionId(session);
  const attention = sessionAttention(session);
  const pending = actionDetail && actionDetail.pending && typeof actionDetail.pending === 'object' ? actionDetail.pending : {};
  const type = actionRequiredType(session, actionDetail);
  const approvalId = cleanText(
    session && session.action_required_approval_id ||
    pending.approval_id ||
    attention.approval_id ||
    attention.pending_approval_id ||
    ''
  );
  const clarifyId = cleanText(
    session && session.action_required_clarify_id ||
    pending.clarify_id ||
    attention.clarify_id ||
    attention.pending_clarify_id ||
    ''
  );
  const count = Number(
    session && session.action_required_count ||
    actionDetail && actionDetail.pending_count ||
    attention.count ||
    (Object.keys(pending).length ? 1 : 0) ||
    0
  );
  const description = cleanText(
    session && session.action_required_description ||
    pending.description ||
    pending.question ||
    attention.description ||
    attention.text ||
    ''
  );
  const command = cleanText(
    session && session.action_required_command ||
    pending.command ||
    attention.command ||
    ''
  );
  const key = cleanText(
    session && session.action_required_key ||
    attention.key ||
    pending.key ||
    (type && sid ? `${type}:${sid}:${type === 'approval' ? approvalId : clarifyId}` : '')
  );
  return {
    action_required: Boolean(session && session.action_required) || type === 'approval' || type === 'clarify',
    action_required_type: type,
    action_required_key: key,
    action_required_count: Number.isFinite(count) && count > 0 ? count : 0,
    action_required_command: command,
    action_required_description: description,
    action_required_approval_id: approvalId,
    action_required_choices: actionRequiredChoices(session, actionDetail),
    action_required_clarify_id: clarifyId
  };
}

function emptyActionRequiredMetadata() {
  return {
    action_required: false,
    action_required_type: '',
    action_required_key: '',
    action_required_count: 0,
    action_required_command: '',
    action_required_description: '',
    action_required_approval_id: '',
    action_required_choices: [],
    action_required_clarify_id: ''
  };
}

function sessionTitle(session) {
  return cleanText(session.display_title || session.title || session.name || 'Session');
}

function messageContentText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return String(part || '');
      return part.text || part.content || part.input_text || '';
    }).join('\n');
  }
  return content == null ? '' : String(content);
}

function compactBubbleText(value, maxChars = 180) {
  const text = cleanText(value);
  if (text.length <= maxChars) return text;
  let clipped = text.slice(0, Math.max(0, maxChars - 3)).trim();
  const boundary = Math.max(
    clipped.lastIndexOf(' '),
    clipped.lastIndexOf('，'),
    clipped.lastIndexOf('。'),
    clipped.lastIndexOf('、'),
    clipped.lastIndexOf(',')
  );
  if (boundary >= Math.floor(maxChars / 2)) clipped = clipped.slice(0, boundary).trim();
  return `${clipped}...`;
}

function latestAssistantTextFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'assistant') {
      const text = compactBubbleText(messageContentText(message));
      if (text) return text;
    }
  }
  return '';
}

function latestActivitySceneText(scene) {
  if (scene && scene.version && scene.version !== 'activity_scene_v1') return '';
  const rows = scene && Array.isArray(scene.activity_rows) ? scene.activity_rows : [];
  const prose = [...rows].reverse().find((row) => {
    if (!row || typeof row !== 'object') return false;
    if (!cleanText(row.text || row.payload && row.payload.text)) return false;
    return row.kind === 'process_prose' || row.role === 'prose' || row.display_hint === 'main_prose';
  });
  if (prose) return compactBubbleText(prose.text || prose.payload && prose.payload.text);
  const fallback = [...rows].reverse().find((row) => row && cleanText(row.text || row.payload && row.payload.text));
  return fallback ? compactBubbleText(fallback.text || fallback.payload && fallback.payload.text) : '';
}

function snapshotStreamId(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const scene = snapshot.anchor_activity_scene || snapshot.anchorActivityScene || {};
  const identity = scene && typeof scene === 'object' ? (scene.identity || {}) : {};
  return cleanText(
    snapshot.stream_id ||
    snapshot.streamId ||
    snapshot.run_id ||
    snapshot.runId ||
    identity.stream_id ||
    identity.streamId ||
    identity.run_id ||
    identity.runId ||
    ''
  );
}

function sessionStreamId(session, runtime = serverWebuiRuntimeState()) {
  const sid = sessionId(session);
  const activeSession = runtime.appState && runtime.appState.session;
  const activeMatches = activeSession && sessionId(activeSession) === sid;
  return cleanText(
    session && (session.active_stream_id || session.activeStreamId) ||
    (activeMatches && (activeSession.active_stream_id || activeSession.activeStreamId)) ||
    (activeMatches && runtime.appState && (runtime.appState.activeStreamId || runtime.appState.active_stream_id)) ||
    ''
  );
}

function snapshotMatchesRunningStream(snapshot, session, runtime = serverWebuiRuntimeState()) {
  const expected = sessionStreamId(session, runtime);
  const actual = snapshotStreamId(snapshot);
  if (expected && actual) return expected === actual;
  if (expected && !actual) return false;
  return true;
}

function runtimeSnapshotForSession(session, detail, runtime = serverWebuiRuntimeState()) {
  const sid = sessionId(session);
  if (!sid) return null;
  if (detail && detail.runtime_journal_snapshot) return detail.runtime_journal_snapshot;
  if (detail && detail.runtimeJournalSnapshot) return detail.runtimeJournalSnapshot;
  const activeSession = runtime.appState && runtime.appState.session;
  if (activeSession && sessionId(activeSession) === sid) {
    if (activeSession.runtime_journal_snapshot) return activeSession.runtime_journal_snapshot;
    if (activeSession.runtimeJournalSnapshot) return activeSession.runtimeJournalSnapshot;
  }
  const inflight = runtime.inflight && runtime.inflight[sid];
  if (inflight && typeof inflight === 'object') {
    return {
      stream_id: inflight.streamId || inflight.stream_id || '',
      last_assistant_text: inflight.lastAssistantText || inflight.last_assistant_text || '',
      last_reasoning_text: inflight.lastReasoningText || inflight.last_reasoning_text || '',
      messages: Array.isArray(inflight.messages) ? inflight.messages : [],
      anchor_activity_scene: inflight.anchorActivityScene || inflight.anchor_activity_scene || null
    };
  }
  return null;
}

function processTextFromRuntime(session, detail, runtime = serverWebuiRuntimeState()) {
  const snapshot = runtimeSnapshotForSession(session, detail, runtime);
  if (snapshot) {
    if (!snapshotMatchesRunningStream(snapshot, session, runtime)) return '';
    const scene = snapshot.anchor_activity_scene || snapshot.anchorActivityScene;
    return compactBubbleText(
      latestActivitySceneText(scene) ||
      snapshot.last_assistant_text ||
      snapshot.lastAssistantText ||
      snapshot.last_reasoning_text ||
      snapshot.lastReasoningText
    );
  }
  const scene = detail && (detail.anchor_activity_scene || detail.anchorActivityScene);
  if (scene) return latestActivitySceneText(scene);
  return '';
}

function latestFinalText(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const messagesText = latestAssistantTextFromMessages(detail.messages);
  if (messagesText) return messagesText;
  const scene = detail.anchor_activity_scene || detail.anchorActivityScene;
  if (scene && scene.final_answer) return compactBubbleText(scene.final_answer);
  return '';
}

function sessionText(session, status, detail = null, runtime = serverWebuiRuntimeState()) {
  const attention = session && session.attention && typeof session.attention === 'object' ? session.attention : {};
  if (status === 'running') {
    return compactBubbleText(
      attention.text ||
      session.process_text ||
      session.status_text ||
      processTextFromRuntime(session, detail, runtime) ||
      'Hermes is working'
    );
  }
  if (status === 'ready') {
    return compactBubbleText(attention.text || latestFinalText(detail) || session.summary || 'Ready to review');
  }
  return cleanText(attention.text || session.process_text || '');
}

// Ported verbatim for fidelity; no caller in the sidecar today.
function normalizeAttentionRows(rows) {
  return rows.map((row) => ({
    session_id: String(row.session_id || ''),
    status: String(row.status || 'idle'),
    title: sessionTitle(row),
    text: sessionText(row, row.status),
    process_text: cleanText(row.process_text || row.text || sessionText(row, row.status)),
    message_count: Number(row.message_count || 0),
    last_message_at: Number(row.last_message_at || row.updated_at || 0),
    updated_at: Number(row.updated_at || 0),
    started_at: Number(row.started_at || 0),
    ...actionRequiredMetadata(row)
  })).filter((item) => item.session_id && item.status !== 'idle');
}

function updateCompletionTransitions(rows, runtime = serverWebuiRuntimeState(), state = attentionState) {
  const now = Date.now();
  const seen = new Set();
  for (const session of Array.isArray(rows) ? rows : []) {
    const sid = sessionId(session);
    if (!sid) continue;
    seen.add(sid);
    const messageCount = Number(session && session.message_count || 0);
    const lastMessageAt = Number(session && session.last_message_at || session.updated_at || 0);
    const localRunning = isLocallyRunningSession(session, runtime);
    const actionContinuation = actionContinuationItem(session);
    const actionCompleted = !localRunning && isActionContinuationCompleted(session, actionContinuation);
    if (actionCompleted) {
      state.recentCompletions.set(sid, {
        completedAt: now,
        messageCount,
        lastMessageAt
      });
      state.recentActionContinuations.delete(sid);
    }
    const running = localRunning || Boolean(actionContinuation && !actionCompleted);
    const previous = state.observedRunning.get(sid);
    if (previous && previous.running && !running) {
      state.recentCompletions.set(sid, {
        completedAt: now,
        messageCount: Math.max(messageCount, Number(previous.messageCount || 0)),
        lastMessageAt: Math.max(lastMessageAt, Number(previous.lastMessageAt || 0))
      });
    }
    if (running) state.recentCompletions.delete(sid);
    state.observedRunning.set(sid, {
      running,
      messageCount,
      lastMessageAt,
      seenAt: now
    });
  }
  for (const [sid, item] of state.recentCompletions) {
    if (now - Number(item.completedAt || 0) > ATTENTION_CONFIG.recentCompletionMs) {
      state.recentCompletions.delete(sid);
    }
  }
  for (const [sid, item] of state.observedRunning) {
    if (!seen.has(sid) && now - Number(item.seenAt || 0) > ATTENTION_CONFIG.recentCompletionMs * 3) {
      state.observedRunning.delete(sid);
    }
  }
}

// Ready unread: sidecar port keeps the completionUnread branch (the marker has
// no writer outside the WebUI page today, so it is usually empty) plus the
// recentCompletions branch that the sidecar itself fills whenever it observes
// a running -> idle transition (the ready channel's only source).
function hasReadyUnread(session, store = petStateStore, state = attentionState) {
  const sid = sessionId(session);
  if (!sid) return false;
  if (Object.prototype.hasOwnProperty.call(store.completionUnread, sid)) {
    const marker = store.completionUnread[sid];
    const completedAt = timestampToMs(marker && typeof marker === 'object'
      ? (marker.completed_at || marker.completedAt)
      : 0);
    const markerCount = Number(marker && typeof marker === 'object'
      ? (marker.message_count || marker.messageCount || 0)
      : 0);
    const sessionCount = Number(session && session.message_count || 0);
    if (
      completedAt > 0 &&
      Date.now() - completedAt <= ATTENTION_CONFIG.completionUnreadMaxAgeMs &&
      (!markerCount || !sessionCount || sessionCount >= markerCount)
    ) {
      return true;
    }
  }
  const recent = state.recentCompletions.get(sid);
  if (!recent) return false;
  if (Date.now() - Number(recent.completedAt || 0) > ATTENTION_CONFIG.recentCompletionMs) {
    state.recentCompletions.delete(sid);
    return false;
  }
  return true;
}

function sessionFreshness(session) {
  return Math.max(
    Number(session && session.last_message_at || 0),
    Number(session && session.updated_at || 0)
  );
}

function mergeSessionMetadata(base, incoming) {
  const left = base && typeof base === 'object' ? base : {};
  const right = incoming && typeof incoming === 'object' ? incoming : {};
  const preferIncoming = sessionFreshness(right) >= sessionFreshness(left);
  const merged = preferIncoming ? { ...left, ...right } : { ...right, ...left };
  for (const field of ['message_count', 'last_message_at', 'updated_at', 'started_at']) {
    const value = Math.max(Number(left[field] || 0), Number(right[field] || 0));
    if (value > 0) merged[field] = value;
  }
  return merged;
}

// Sidecar port: runtime.allSessions/appState are empty, so only server rows
// survive (adapter merged the in-page session list on top of them).
function mergeSessionRows(serverSessions, runtime = serverWebuiRuntimeState()) {
  const bySid = new Map();
  for (const row of Array.isArray(serverSessions) ? serverSessions : []) {
    const sid = sessionId(row);
    if (sid) bySid.set(sid, { ...row });
  }
  for (const row of runtime.allSessions || []) {
    const sid = sessionId(row);
    if (!sid) continue;
    bySid.set(sid, mergeSessionMetadata(bySid.get(sid), row));
  }
  const active = runtime.appState && runtime.appState.session;
  const activeSid = sessionId(active);
  if (activeSid) {
    const { messages: _messages, tool_calls: _toolCalls, ...activeMeta } = active;
    bySid.set(activeSid, mergeSessionMetadata(bySid.get(activeSid), activeMeta));
  }
  return [...bySid.values()];
}

async function fetchSessionDetail(session, status, fetchWebui = null) {
  const sid = sessionId(session);
  if (!sid || !['running', 'ready', 'action_required'].includes(status)) return null;
  if (typeof fetchWebui !== 'function') return null;
  const messages = status === 'ready' ? '1' : '0';
  const query = new URLSearchParams({
    session_id: sid,
    messages,
    resolve_model: '0',
    msg_limit: status === 'ready' ? '8' : '1',
    expand_renderable: '1'
  });
  try {
    const response = await fetchWebui(`/api/session?${query.toString()}`);
    if (!response || !response.ok) return null;
    const data = response && response.data;
    return data && data.session && typeof data.session === 'object' ? data.session : null;
  } catch (_) {
    return null;
  }
}

async function fetchActionDetail(session, status, fetchWebui = null) {
  if (status !== 'action_required') return null;
  const sid = sessionId(session);
  if (!sid || typeof fetchWebui !== 'function') return null;
  const type = actionRequiredType(session);
  const paths = type === 'approval'
    ? ['/api/approval/pending']
    : (type === 'clarify' ? ['/api/clarify/pending'] : ['/api/approval/pending', '/api/clarify/pending']);
  for (const path of paths) {
    const query = new URLSearchParams({ session_id: sid });
    try {
      const response = await fetchWebui(`${path}?${query.toString()}`);
      if (!response || !response.ok) continue;
      const data = response && response.data;
      if (data && data.pending && typeof data.pending === 'object') {
        return {
          pending: data.pending,
          pending_count: Number(data.pending_count || 0) || 1
        };
      }
    } catch (_) { /* try next path */ }
  }
  return null;
}

function hasLiveActionDetail(actionDetail) {
  return Boolean(actionDetail && actionDetail.pending && typeof actionDetail.pending === 'object');
}

// Ported buildAttention (adapter). ctx.fetchWebui is the per-server webuiFetch
// (optionally injected for tests); ctx.store defaults to petStateStore.
async function serverBuildAttention(sessions, ctx = {}) {
  const runtime = serverWebuiRuntimeState();
  const store = ctx.store && typeof ctx.store === 'object' ? ctx.store : petStateStore;
  const state = ctx.state && typeof ctx.state === 'object' ? ctx.state : attentionState;
  const fetchWebui = typeof ctx.fetchWebui === 'function' ? ctx.fetchWebui : null;
  const rows = mergeSessionRows(sessions, runtime);
  updateCompletionTransitions(rows, runtime, state);
  const candidates = rows
    .map((session) => {
      const explicit = explicitAttention(session);
      const running = isLocallyRunningSession(session, runtime);
      const ready = hasReadyUnread(session, store, state);
      if (ready) state.recentActionContinuations.delete(sessionId(session));
      const continuing = !running && !ready && isActionContinuationSession(session);
      const status = explicit || (running || continuing ? 'running' : (ready ? 'ready' : 'idle'));
      return { session, status };
    })
    .filter(({ session, status }) => sessionId(session) && status !== 'idle')
    .sort((a, b) => {
      const priority = { action_required: 3, running: 2, ready: 1 };
      if (a.status !== b.status) return (priority[b.status] || 0) - (priority[a.status] || 0);
      const aTime = Number(a.session.last_message_at || a.session.updated_at || 0);
      const bTime = Number(b.session.last_message_at || b.session.updated_at || 0);
      return bTime - aTime;
    })
    .slice(0, ATTENTION_CONFIG.maxAttention);

  const hydrated = await Promise.all(candidates.map(async ({ session, status }) => ({
    session,
    status,
    detail: await fetchSessionDetail(session, status, fetchWebui),
    actionDetail: await fetchActionDetail(session, status, fetchWebui)
  })));

  return hydrated
    .map(({ session, status, detail, actionDetail }) => {
      let finalStatus = status;
      if (status === 'action_required' && !hasLiveActionDetail(actionDetail)) {
        if (hasReadyUnread(session, store, state)) {
          finalStatus = 'ready';
        } else if (isActionContinuationSession(session)) {
          finalStatus = 'running';
        } else {
          return null;
        }
      }
      const action = finalStatus === 'action_required'
        ? actionRequiredMetadata(session, actionDetail)
        : emptyActionRequiredMetadata();
      const baseText = sessionText(session, finalStatus, detail, runtime);
      const text = finalStatus === 'action_required'
        ? compactBubbleText(action.action_required_description || action.action_required_command || baseText || 'Action required')
        : baseText;
      return {
        session_id: sessionId(session),
        status: finalStatus,
        title: sessionTitle(session),
        text,
        process_text: text,
        message_count: Number(session.message_count || 0),
        last_message_at: Number(session.last_message_at || session.updated_at || 0),
        updated_at: Number(session.updated_at || 0),
        started_at: Number(session.started_at || 0),
        ...action
      };
    })
    .filter((item) => item && item.session_id && item.status !== 'idle');
}

function parseAllowedOrigins(value) {
  if (!value) return null;
  return new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function isDefaultLoopbackOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

export function normalizePort(value, fallback = 17787) {
  if (value === undefined || value === null || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function sendText(res, status, text, contentType, headers = {}) {
  const payload = Buffer.from(text);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': payload.length,
    ...headers
  });
  res.end(payload);
}

function sendBuffer(res, status, buffer, contentType, headers = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buffer.length,
    ...headers
  });
  res.end(buffer);
}

function sendHead(res, status, contentType, contentLength = 0, headers = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': contentLength,
    ...headers
  });
  res.end();
}

function defaultPreferencePath() {
  return path.join(os.homedir(), '.hermes-webui-desktop-companion', 'preferences.json');
}

function defaultPetSkinSelectionPath() {
  return path.join(os.homedir(), '.hermes-webui-desktop-companion', 'skin-selection.json');
}

function normalizePreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_PREFERENCES.enabled,
    allow_direct_send: typeof source.allow_direct_send === 'boolean' ? source.allow_direct_send : DEFAULT_PREFERENCES.allow_direct_send,
    allow_inline_action_responses: typeof source.allow_inline_action_responses === 'boolean'
      ? source.allow_inline_action_responses
      : DEFAULT_PREFERENCES.allow_inline_action_responses
  };
}

function loadPreferences(preferencePath) {
  if (!preferencePath) return normalizePreferences();
  try {
    return normalizePreferences(JSON.parse(readFileSync(preferencePath, 'utf8')));
  } catch (_) {
    return normalizePreferences();
  }
}

function savePreferences(preferencePath, preferences) {
  if (!preferencePath) return;
  mkdirSync(path.dirname(preferencePath), { recursive: true });
  writeFileSync(preferencePath, `${JSON.stringify(normalizePreferences(preferences), null, 2)}\n`, 'utf8');
}

function normalizePetSkinSelection(value) {
  const source = value && typeof value === 'object' ? value : {};
  const skinId = safeSkinId(source.skin_id || source.skinId);
  const updatedAtMs = Number(source.updated_at_ms);
  return {
    skin_id: skinId,
    updated_at_ms: skinId && Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : 0,
    updated_at: skinId && Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs / 1000 : null
  };
}

function loadPetSkinSelection(selectionPath) {
  if (!selectionPath) return normalizePetSkinSelection();
  try {
    return normalizePetSkinSelection(JSON.parse(readFileSync(selectionPath, 'utf8')));
  } catch (_) {
    return normalizePetSkinSelection();
  }
}

function savePetSkinSelection(selectionPath, selection) {
  if (!selectionPath) return;
  const dir = path.dirname(selectionPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.skin-selection-${process.pid}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(normalizePetSkinSelection(selection), null, 2)}\n`, 'utf8');
  renameSync(tmpPath, selectionPath);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 128) {
      throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

function corsHeaders(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const allowed = allowedOrigins ? allowedOrigins.has(origin) : isDefaultLoopbackOrigin(origin);
  if (!allowed) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin'
  };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.icns') return 'image/icns';
  return 'application/octet-stream';
}

function safeStaticPath(root, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  if (decoded.includes('\0')) return null;
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const target = path.resolve(root, normalized.replace(/^[/\\]+/, ''));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (relative.split(path.sep).some((part) => part.startsWith('.'))) return null;
  return target;
}

function safeChildPath(root, requestPath) {
  if (!requestPath || String(requestPath).includes('\0')) return null;
  const target = path.resolve(root, String(requestPath));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

async function serveStatic(res, root, requestPath, headers = {}) {
  const target = safeStaticPath(root, requestPath);
  if (!target) {
    sendJson(res, 404, { ok: false, error: 'not_found' }, headers);
    return true;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const buffer = await readFile(target);
    sendBuffer(res, 200, buffer, contentTypeFor(target), headers);
  } catch (_) {
    sendJson(res, 404, { ok: false, error: 'not_found' }, headers);
  }
  return true;
}

function snapshotTimestampMs(latestSnapshot) {
  const timestamp = latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot.timestamp : '';
  const parsed = Date.parse(String(timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotAttentionState(latestSnapshot, now = Date.now()) {
  if (!latestSnapshot || typeof latestSnapshot !== 'object') return 'empty';
  if (String(latestSnapshot.reason || '').toLowerCase() === 'unload') return 'unloaded';
  const timestampMs = snapshotTimestampMs(latestSnapshot);
  if (timestampMs > 0 && now - timestampMs > PET_SNAPSHOT_ATTENTION_TTL_MS) return 'stale';
  return 'fresh';
}

function latestAttention(latestSnapshot, now = Date.now()) {
  if (snapshotAttentionState(latestSnapshot, now) !== 'fresh') return [];
  const companion = latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot.companion : null;
  const attention = companion && Array.isArray(companion.attention) ? companion.attention : [];
  return attention.map((item) => ({
    session_id: String(item.session_id || ''),
    status: String(item.status || 'idle'),
    title: String(item.title || 'Session'),
    text: String(item.text || ''),
    process_text: String(item.process_text || item.text || ''),
    message_count: Number(item.message_count || 0),
    last_message_at: Number(item.last_message_at || item.updated_at || 0),
    updated_at: Number(item.updated_at || 0),
    started_at: Number(item.started_at || 0),
    action_required: Boolean(item.action_required),
    action_required_type: String(item.action_required_type || ''),
    action_required_key: String(item.action_required_key || ''),
    action_required_count: Number(item.action_required_count || 0),
    action_required_command: String(item.action_required_command || ''),
    action_required_description: String(item.action_required_description || ''),
    action_required_approval_id: String(item.action_required_approval_id || ''),
    action_required_choices: Array.isArray(item.action_required_choices) ? item.action_required_choices : [],
    action_required_clarify_id: String(item.action_required_clarify_id || '')
  })).filter((item) => item.session_id && item.status !== 'idle');
}

function safeLoopbackWebuiUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    if (!['http:', 'https:'].includes(url.protocol) || !loopback) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function latestWebuiUrl(latestSnapshot) {
  return safeLoopbackWebuiUrl(latestSnapshot && latestSnapshot.page && latestSnapshot.page.href);
}

function latestWebuiOrigin(latestSnapshot) {
  const url = latestWebuiUrl(latestSnapshot);
  return url ? url.origin : null;
}

function latestWebuiHref(latestSnapshot) {
  const url = latestWebuiUrl(latestSnapshot);
  return url ? url.href : null;
}

function configuredWebuiUrl(options = {}) {
  return safeLoopbackWebuiUrl(
    options.webuiBaseUrl
      || process.env.HERMES_DESKTOP_COMPANION_WEBUI_BASE
      || DEFAULT_WEBUI_BASE_URL
  );
}

function webuiSessionPath(value) {
  const url = typeof value === 'string' ? safeLoopbackWebuiUrl(value) : value;
  if (!url) return '';
  const match = url.pathname.match(/^\/session\/([A-Za-z0-9_-]{1,128})(?:\/)?$/);
  return match ? `/session/${match[1]}` : '';
}

function isProcessAlive(pid) {
  const parsed = Number(pid || 0);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function safeSessionId(value) {
  const sid = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(sid) ? sid : '';
}

function openExternalUrl(url, options = {}) {
  if (options.openExternal === false) return Promise.resolve(false);
  if (typeof options.openExternal === 'function') return Promise.resolve(Boolean(options.openExternal(url)));

  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : (platform === 'win32' ? 'cmd' : 'xdg-open');
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function normalizeFocusResult(value) {
  if (value && typeof value === 'object') {
    return {
      focused: Boolean(value.focused || value.reused || value.opened),
      reused: Boolean(value.reused),
      opened: Boolean(value.opened)
    };
  }
  return {
    focused: Boolean(value),
    reused: Boolean(value),
    opened: false
  };
}

function loopbackHostCandidates(value) {
  try {
    const url = new URL(value);
    const candidates = [];
    if (url.host) candidates.push(url.host);
    if (url.port) {
      candidates.push(`127.0.0.1:${url.port}`);
      candidates.push(`localhost:${url.port}`);
      candidates.push(`0.0.0.0:${url.port}`);
      if (url.port === '8787') {
        candidates.push('127.0.0.1:8790');
        candidates.push('localhost:8790');
        candidates.push('0.0.0.0:8790');
      }
    }
    return [...new Set(candidates.filter(Boolean))];
  } catch (_) {
    return [];
  }
}

function runAppleScript(script, args = [], timeoutMs = 2500) {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-', ...args], {
      stdio: ['pipe', 'pipe', 'ignore']
    });
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish('');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(''));
    child.on('close', (code) => finish(code === 0 ? stdout.trim() : ''));
    child.stdin.end(script);
  });
}

async function focusExistingMacChromeTab(url, origin) {
  const hostCandidates = loopbackHostCandidates(origin || url);
  if (!hostCandidates.length) return normalizeFocusResult(false);
  const targetSessionPath = webuiSessionPath(url);
  const script = `
on isSameTargetSession(currentUrl, targetSessionPath)
  if targetSessionPath is "" then return false
  if currentUrl does not contain targetSessionPath then return false
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to targetSessionPath
  set urlParts to text items of currentUrl
  set AppleScript's text item delimiters to oldDelimiters
  if (count of urlParts) < 2 then return false
  set suffixText to item 2 of urlParts
  if suffixText is "" then return true
  set firstChar to character 1 of suffixText as string
  if firstChar is "?" then return true
  if firstChar is "#" then return true
  if firstChar is "/" then return true
  return false
end isSameTargetSession

on shouldNavigate(currentUrl, targetUrl, targetSessionPath)
  if currentUrl is targetUrl then return false
  if isSameTargetSession(currentUrl, targetSessionPath) then return false
  return true
end shouldNavigate

on run argv
  set targetUrl to item 1 of argv
  set targetSessionPath to item 2 of argv
  set hostCandidates to {}
  repeat with idx from 3 to count of argv
    set end of hostCandidates to item idx of argv
  end repeat
  if application "Google Chrome" is not running then return "not_running"
  tell application "Google Chrome"
    try
      if (count windows) > 0 then
        set activeUrl to URL of active tab of front window
        repeat with hostText in hostCandidates
          if activeUrl contains hostText then
            if my shouldNavigate(activeUrl, targetUrl, targetSessionPath) then
              set URL of active tab of front window to targetUrl
            end if
            set index of front window to 1
            activate
            try
              tell application "System Events" to set frontmost of process "Google Chrome" to true
            end try
            return "reused"
          end if
        end repeat
      end if
    end try
    repeat with w from 1 to count windows
      repeat with tabIndex from 1 to count tabs of window w
        set currentUrl to URL of tab tabIndex of window w
        repeat with hostText in hostCandidates
          if currentUrl contains hostText then
            if my shouldNavigate(currentUrl, targetUrl, targetSessionPath) then
              set URL of tab tabIndex of window w to targetUrl
            end if
            set active tab index of window w to tabIndex
            try
              set index of window w to 1
            end try
            activate
            try
              tell application "System Events" to set frontmost of process "Google Chrome" to true
            end try
            return "reused"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end run
`;
  const result = await runAppleScript(script, [url, targetSessionPath, ...hostCandidates]);
  return normalizeFocusResult({
    focused: result === 'reused',
    reused: result === 'reused',
    opened: false
  });
}

async function focusExistingBrowserTab(url, origin, options = {}) {
  if (options.focusExistingBrowserTab === false) return normalizeFocusResult(false);
  if (typeof options.focusExistingBrowserTab === 'function') {
    return normalizeFocusResult(await options.focusExistingBrowserTab(url, origin));
  }
  if (process.platform === 'darwin') return focusExistingMacChromeTab(url, origin);
  return normalizeFocusResult(false);
}

async function focusOrOpenBrowserUrl(url, origin, options = {}) {
  const focused = await focusExistingBrowserTab(url, origin, options);
  if (focused.focused || focused.reused) return focused;
  const opened = await openExternalUrl(url, options);
  return normalizeFocusResult({ focused: opened, opened, reused: false });
}

function safePetSlug(value) {
  const slug = String(value || '').trim();
  if (slug.includes('/') || slug.includes('\\')) return '';
  return /^[A-Za-z0-9_-]{1,128}$/.test(slug) ? slug : '';
}

function safeSkinId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}

function hermesPetsRoot(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'hermesPetsDir')) {
    return options.hermesPetsDir ? path.resolve(String(options.hermesPetsDir)) : null;
  }
  const configured = process.env.HERMES_DESKTOP_COMPANION_HERMES_PETS_DIR || process.env.HERMES_PETS_DIR;
  if (configured) return path.resolve(configured);
  return path.join(process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'), 'pets');
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (_) {
    return {};
  }
}

async function resolveHermesPet(root, slug) {
  const safeSlug = safePetSlug(slug);
  if (!root || !safeSlug) return null;
  const directory = path.join(root, safeSlug);
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  try {
    const info = await stat(directory);
    if (!info.isDirectory()) return null;
  } catch (_) {
    return null;
  }

  const manifest = await readJsonFile(path.join(directory, 'pet.json'));
  const declared = String(manifest.spritesheetPath || '').trim();
  const candidates = [];
  if (declared) {
    const declaredPath = safeChildPath(directory, declared);
    if (declaredPath) candidates.push(declaredPath);
  }
  for (const name of ['spritesheet.webp', 'spritesheet.png', 'sprite.webp', 'sprite.png']) {
    candidates.push(path.join(directory, name));
  }

  for (const spritesheet of candidates) {
    try {
      const info = await stat(spritesheet);
      if (info.isFile()) {
        return {
          slug: safeSlug,
          manifest,
          directory,
          spritesheet
        };
      }
    } catch (_) {}
  }
  return null;
}

function pngDimensions(buffer) {
  if (buffer.length < 24) return null;
  if (
    buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47
    || buffer[4] !== 0x0d || buffer[5] !== 0x0a || buffer[6] !== 0x1a || buffer[7] !== 0x0a
    || buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b1 = buffer[21], b2 = buffer[22], b3 = buffer[23], b4 = buffer[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
    };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  return null;
}

async function imageDimensions(filePath) {
  try {
    const buffer = await readFile(filePath);
    return pngDimensions(buffer) || webpDimensions(buffer);
  } catch (_) {
    return null;
  }
}

function petLayoutForDimensions(dimensions) {
  const width = Number(dimensions && dimensions.width || 0);
  const height = Number(dimensions && dimensions.height || 0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width % PET_FRAME_WIDTH !== 0 || height % PET_FRAME_HEIGHT !== 0) return null;
  const columns = width / PET_FRAME_WIDTH;
  const rows = height / PET_FRAME_HEIGHT;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) return null;
  const codexRows = rows >= CODEX_PET_ROWS.length;
  const rowForState = rows >= CODEX_PET_ROWS.length
    ? Object.fromEntries(CODEX_PET_ROWS.map((name, row) => [name, row]))
    : LEGACY_PET_ROW_BY_STATE;
  return {
    columns,
    rows,
    frameWidth: PET_FRAME_WIDTH,
    frameHeight: PET_FRAME_HEIGHT,
    states: CODEX_PET_ROWS.map((name) => ({
      name,
      row: Math.max(0, Math.min(rows - 1, Number(rowForState[name] || 0))),
      frames: Math.max(1, Math.min(codexRows ? CODEX_PET_FRAMES_BY_STATE[name] : PET_FRAMES_PER_STATE, columns))
    }))
  };
}

async function hermesPetSkin(root, slug) {
  const pet = await resolveHermesPet(root, slug);
  if (!pet) return null;
  const displayName = String(pet.manifest.displayName || pet.manifest.name || pet.slug).trim() || pet.slug;
  const description = String(pet.manifest.description || '').trim();
  const layout = petLayoutForDimensions(await imageDimensions(pet.spritesheet));
  if (!layout) return null;
  const spriteName = path.basename(pet.spritesheet);
  return {
    id: `hermes-${pet.slug}`,
    displayName,
    description,
    source: 'hermes-pets',
    hermesPetSlug: pet.slug,
    spritesheetUrl: `/api/pet/hermes-pets/${encodeURIComponent(pet.slug)}/${encodeURIComponent(spriteName)}`,
    layout
  };
}

async function hermesPetSkins(options = {}) {
  const root = hermesPetsRoot(options);
  if (!root) return [];
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const skins = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = safePetSlug(entry.name);
    if (!slug) continue;
    const skin = await hermesPetSkin(root, slug);
    if (skin) skins.push(skin);
  }
  return skins;
}

async function installedHermesPetSlugs(options = {}) {
  const root = hermesPetsRoot(options);
  if (!root) return new Set();
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (_) {
    return new Set();
  }
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => safePetSlug(entry.name)).filter(Boolean));
}

async function petSkins() {
  const ids = ['keeper', 'shiba', 'courier'];
  const skins = [];
  for (const id of ids) {
    try {
      const directory = path.join(PETS_ROOT, id);
      const raw = await readFile(path.join(directory, 'pet.json'), 'utf8');
      const manifest = JSON.parse(raw);
      const declared = String(manifest.spritesheetPath || 'spritesheet.webp').trim() || 'spritesheet.webp';
      const spritesheet = safeChildPath(directory, declared) || path.join(directory, 'spritesheet.webp');
      const layout = petLayoutForDimensions(await imageDimensions(spritesheet));
      const skin = {
        id: String(manifest.id || id),
        displayName: String(manifest.displayName || manifest.id || id),
        description: String(manifest.description || ''),
        spritesheetUrl: `/extensions/pets/${id}/${encodeURIComponent(path.basename(spritesheet))}`
      };
      if (layout) skin.layout = layout;
      skins.push(skin);
    } catch (_) {}
  }
  return skins;
}

async function allPetSkins(options = {}) {
  return [...await petSkins(), ...await hermesPetSkins(options)];
}

function normalizePetGalleryLimit(value) {
  const limit = Number(value || PET_GALLERY_DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) return PET_GALLERY_DEFAULT_LIMIT;
  return Math.min(limit, PET_GALLERY_MAX_LIMIT);
}

function normalizePetGalleryOffset(value) {
  const offset = Number(value || 0);
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

function normalizeGalleryPet(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const slug = safePetSlug(source.slug);
  if (!slug) return null;
  const displayName = String(source.displayName || source.name || slug).replace(/\s+/g, ' ').trim() || slug;
  const kind = String(source.kind || '').replace(/\s+/g, ' ').trim();
  const submittedBySource = source.submittedBy && typeof source.submittedBy === 'object'
    ? source.submittedBy.name || source.submittedBy.handle || source.submittedBy.username
    : source.submittedBy;
  const submittedBy = String(submittedBySource || '').replace(/\s+/g, ' ').trim();
  const spritesheetUrl = String(source.spritesheetUrl || source.spritesheetPath || '').trim();
  const description = String(source.description || '').replace(/\s+/g, ' ').trim();
  const zipUrl = String(source.zipUrl || '').trim();
  return {
    slug,
    displayName,
    kind,
    submittedBy,
    description,
    spritesheetUrl: /^https?:\/\//.test(spritesheetUrl) ? spritesheetUrl : '',
    zipUrl: /^https?:\/\//.test(zipUrl) ? zipUrl : '',
    previewUrl: `/api/pet/gallery/preview/${encodeURIComponent(slug)}`,
    source: 'petdex'
  };
}

function petGallerySearchUrl(options = {}) {
  return String(options.petGallerySearchUrl || process.env.HERMES_PETDEX_SEARCH_URL || PET_GALLERY_SEARCH_URL);
}

function petGalleryInstallUrl(options = {}, slug = '') {
  const base = String(options.petGalleryInstallUrl || process.env.HERMES_PETDEX_INSTALL_URL || PET_GALLERY_INSTALL_URL).replace(/\/+$/g, '');
  return `${base}/${encodeURIComponent(slug)}`;
}

function testPetGalleryManifest(options = {}) {
  if (!Array.isArray(options.petGalleryPets)) return null;
  return {
    generatedAt: null,
    total: options.petGalleryPets.length,
    pets: options.petGalleryPets
  };
}

async function fetchPetGalleryManifest(options = {}) {
  const fixtureManifest = testPetGalleryManifest(options);
  if (fixtureManifest) return fixtureManifest;

  const manifestUrl = String(options.petGalleryManifestUrl || process.env.HERMES_PETDEX_MANIFEST_URL || PET_GALLERY_MANIFEST_URL);
  const now = Date.now();
  if (petGalleryCache && petGalleryCache.url === manifestUrl && petGalleryCache.expiresAt > now) {
    return petGalleryCache.manifest;
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('Pet gallery fetch is not available'), { statusCode: 502, code: 'pet_gallery_fetch_unavailable' });
  }
  const response = await fetchImpl(manifestUrl, {
    headers: { accept: 'application/json' }
  });
  if (!response || !response.ok) {
    throw Object.assign(new Error(`Pet gallery manifest failed: ${response && response.status || 'unknown'}`), { statusCode: 502, code: 'pet_gallery_manifest_failed' });
  }
  const manifest = await response.json();
  petGalleryCache = {
    url: manifestUrl,
    expiresAt: now + PET_GALLERY_CACHE_MS,
    manifest
  };
  return manifest;
}

async function petGalleryFromManifest(query, offset, limit, options = {}) {
  const manifest = await fetchPetGalleryManifest(options);
  const allPets = (Array.isArray(manifest && manifest.pets) ? manifest.pets : [])
    .map(normalizeGalleryPet)
    .filter(Boolean);
  const filtered = query
    ? allPets.filter((pet) => [pet.slug, pet.displayName, pet.kind, pet.submittedBy].some((value) => String(value || '').toLowerCase().includes(query)))
    : allPets;
  return {
    source: 'petdex-manifest',
    generatedAt: manifest && manifest.generatedAt || null,
    total: filtered.length,
    manifestTotal: Number(manifest && manifest.total || allPets.length),
    pets: filtered.slice(offset, offset + limit)
  };
}

async function petGalleryFromLiveSearch(query, offset, limit, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('Pet gallery fetch is not available'), { statusCode: 502, code: 'pet_gallery_fetch_unavailable' });
  }
  const searchUrl = new URL(petGallerySearchUrl(options));
  if (query) searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('sort', 'recent');
  searchUrl.searchParams.set('cursor', String(offset));
  searchUrl.searchParams.set('limit', String(limit));
  searchUrl.searchParams.set('includeMeta', '1');
  const now = Date.now();
  const cacheKey = searchUrl.toString();
  if (petGalleryCache && petGalleryCache.url === cacheKey && petGalleryCache.expiresAt > now) {
    return petGalleryCache.manifest;
  }
  const response = await fetchImpl(searchUrl, {
    headers: { accept: 'application/json' }
  });
  if (!response || !response.ok) {
    throw Object.assign(new Error(`Pet gallery search failed: ${response && response.status || 'unknown'}`), { statusCode: 502, code: 'pet_gallery_search_failed' });
  }
  const body = await response.json();
  const pets = (Array.isArray(body && body.pets) ? body.pets : [])
    .map(normalizeGalleryPet)
    .filter(Boolean);
  const result = {
    source: 'petdex-live',
    generatedAt: null,
    total: Number(body && body.total || pets.length),
    manifestTotal: Number(body && body.total || pets.length),
    pets
  };
  petGalleryCache = {
    url: cacheKey,
    expiresAt: now + PET_GALLERY_CACHE_MS,
    manifest: result
  };
  return result;
}

async function petGalleryPage(query, offset, limit, options = {}) {
  if (Array.isArray(options.petGalleryPets)) {
    return petGalleryFromManifest(query, offset, limit, options);
  }
  try {
    return await petGalleryFromLiveSearch(query, offset, limit, options);
  } catch (error) {
    if (options.disablePetGalleryManifestFallback === true) throw error;
    return petGalleryFromManifest(query, offset, limit, options);
  }
}

async function petGalleryResponse(url, options = {}) {
  const installedSkins = await hermesPetSkins(options);
  const installedBySlug = new Map(installedSkins.map((skin) => [skin.hermesPetSlug, skin]));
  const installedSlugs = await installedHermesPetSlugs(options);
  const query = String(url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const offset = normalizePetGalleryOffset(url.searchParams.get('offset'));
  const limit = normalizePetGalleryLimit(url.searchParams.get('limit'));
  const page = await petGalleryPage(query, offset, limit, options);
  const pets = page.pets.map((pet) => ({
    ...pet,
    installed: installedSlugs.has(pet.slug),
    skinId: installedSlugs.has(pet.slug) ? `hermes-${pet.slug}` : null,
    installedSkin: installedBySlug.get(pet.slug) || null,
    compatibility: installedSlugs.has(pet.slug)
      ? (installedBySlug.has(pet.slug) ? 'supported' : 'unsupported')
      : 'unchecked'
  }));
  return {
    ok: true,
    source: page.source,
    generatedAt: page.generatedAt,
    total: page.total,
    manifestTotal: page.manifestTotal,
    offset,
    limit,
    query,
    installedCount: installedSlugs.size,
    pets
  };
}

async function petGalleryPetBySlug(slug, options = {}) {
  const safeSlug = safePetSlug(slug);
  if (!safeSlug) return null;
  if (!Array.isArray(options.petGalleryPets)) {
    try {
      const metadata = await fetchPetdexInstallMetadata(safeSlug, options);
      return normalizeGalleryPet({
        slug: metadata.slug,
        displayName: metadata.displayName,
        spritesheetUrl: metadata.spritesheetUrl
      });
    } catch (_) {}
  }
  const manifest = await fetchPetGalleryManifest(options);
  return (Array.isArray(manifest && manifest.pets) ? manifest.pets : [])
    .map(normalizeGalleryPet)
    .find((pet) => pet && pet.slug === safeSlug) || null;
}

async function servePetGalleryPreview(res, requestPath, options = {}, headers = {}) {
  const match = requestPath.match(/^\/api\/pet\/gallery\/preview\/([^/]+)$/);
  if (!match) return false;
  const slug = safePetSlug(decodeURIComponent(match[1]));
  const pet = await petGalleryPetBySlug(slug, options);
  if (!pet || !pet.spritesheetUrl) {
    sendJson(res, 404, { ok: false, error: 'not_found' }, headers);
    return true;
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    sendJson(res, 502, { ok: false, error: 'pet_gallery_fetch_unavailable' }, headers);
    return true;
  }
  try {
    const response = await fetchImpl(pet.spritesheetUrl, {
      headers: { accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8' }
    });
    if (!response || !response.ok) {
      sendJson(res, 502, { ok: false, error: 'pet_preview_fetch_failed' }, headers);
      return true;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers && response.headers.get && response.headers.get('content-type');
    sendBuffer(res, 200, buffer, type && /^image\//.test(type) ? type : contentTypeFor(new URL(pet.spritesheetUrl).pathname), {
      'cache-control': 'public, max-age=3600',
      ...headers
    });
  } catch (_) {
    sendJson(res, 502, { ok: false, error: 'pet_preview_fetch_failed' }, headers);
  }
  return true;
}

function hermesCliCommand(options = {}) {
  return String(options.hermesCli || process.env.HERMES_DESKTOP_COMPANION_HERMES_CLI || process.env.HERMES_CLI || 'hermes');
}

function hermesCliArgs(options = {}, args = []) {
  const moduleName = options.hermesCliModule || process.env.HERMES_DESKTOP_COMPANION_HERMES_CLI_MODULE;
  return moduleName ? ['-m', String(moduleName), ...args] : args;
}

function hermesCliEnv(options = {}) {
  const env = { ...process.env };
  if (options.hermesPetsDir && path.basename(path.resolve(String(options.hermesPetsDir))) === 'pets') {
    env.HERMES_HOME = path.dirname(path.resolve(String(options.hermesPetsDir)));
  }
  return env;
}

function trimCommandOutput(value) {
  return String(value || '').replace(/\s+$/g, '').slice(-4000);
}

async function runHermesPetsCommand(options = {}, args = []) {
  if (typeof options.runHermesPetsCommand === 'function') {
    return options.runHermesPetsCommand(args);
  }
  const command = hermesCliCommand(options);
  const timeoutMs = Number(options.hermesCliTimeoutMs || 120_000);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, hermesCliArgs(options, args), {
      env: hermesCliEnv(options),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(Object.assign(new Error('Hermes pet command timed out'), {
        statusCode: 504,
        code: 'hermes_cli_timeout',
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr)
      }));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(error, {
        statusCode: 502,
        code: 'hermes_cli_unavailable',
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr)
      }));
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        exitCode,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr)
      };
      if (exitCode === 0) {
        resolve(result);
        return;
      }
      reject(Object.assign(new Error(result.stderr || result.stdout || `Hermes pet command failed with exit ${exitCode}`), {
        statusCode: 502,
        code: 'hermes_cli_failed',
        ...result
      }));
    });
  });
}

async function installedPetState(slug, options = {}) {
  const root = hermesPetsRoot(options);
  const pet = await resolveHermesPet(root, slug);
  const skin = await hermesPetSkin(root, slug);
  return {
    installed: Boolean(pet),
    supported: Boolean(skin),
    skin
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

async function fetchJsonFromUrl(url, options = {}, errorCode = 'petdex_fetch_failed') {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('Petdex fetch is not available'), { statusCode: 502, code: 'petdex_fetch_unavailable' });
  }
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' }
  });
  if (!response || !response.ok) {
    throw Object.assign(new Error(`Petdex fetch failed: ${response && response.status || 'unknown'}`), { statusCode: 502, code: errorCode });
  }
  return response.json();
}

async function fetchBufferFromUrl(url, options = {}, errorCode = 'petdex_asset_fetch_failed') {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('Petdex fetch is not available'), { statusCode: 502, code: 'petdex_fetch_unavailable' });
  }
  const response = await fetchImpl(url, {
    headers: { accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8' }
  });
  if (!response || !response.ok) {
    throw Object.assign(new Error(`Petdex asset fetch failed: ${response && response.status || 'unknown'}`), { statusCode: 502, code: errorCode });
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchPetdexInstallMetadata(slug, options = {}) {
  const safeSlug = safePetSlug(slug);
  if (!safeSlug) {
    throw Object.assign(new Error('invalid_pet_slug'), { statusCode: 400, code: 'invalid_pet_slug' });
  }
  const body = await fetchJsonFromUrl(petGalleryInstallUrl(options, safeSlug), options, 'petdex_install_metadata_failed');
  const pet = body && body.pet && typeof body.pet === 'object' ? body.pet : null;
  if (!body || body.ok !== true || !pet || safePetSlug(pet.slug) !== safeSlug || !isHttpUrl(pet.petJsonUrl) || !isHttpUrl(pet.spritesheetUrl)) {
    throw Object.assign(new Error(`Petdex install metadata not found for ${safeSlug}`), { statusCode: 404, code: 'petdex_install_metadata_not_found' });
  }
  return {
    slug: safeSlug,
    displayName: String(pet.displayName || safeSlug).replace(/\s+/g, ' ').trim() || safeSlug,
    petJsonUrl: String(pet.petJsonUrl),
    spritesheetUrl: String(pet.spritesheetUrl),
    spriteExt: String(pet.spriteExt || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
  };
}

function shouldUseDirectPetdexInstall(error) {
  if (!error || error.code !== 'hermes_cli_failed') return false;
  const output = `${error.message || ''}\n${error.stdout || ''}\n${error.stderr || ''}`.toLowerCase();
  return /petdex manifest|not in the manifest|not in petdex manifest|not found in manifest/.test(output);
}

function localSpritesheetName(manifest, metadata) {
  const declared = String(manifest && manifest.spritesheetPath || '').trim();
  const declaredName = declared ? path.basename(declared) : '';
  if (declaredName && !declaredName.startsWith('.')) return declaredName;
  const ext = metadata.spriteExt || path.extname(new URL(metadata.spritesheetUrl).pathname).replace(/^\./, '') || 'webp';
  return `spritesheet.${ext}`;
}

async function installPetdexPetDirect(slug, body, options = {}, cliError = null) {
  const root = hermesPetsRoot(options);
  if (!root) {
    throw Object.assign(new Error('Hermes pets directory is unavailable'), { statusCode: 500, code: 'hermes_pets_dir_unavailable' });
  }
  const metadata = await fetchPetdexInstallMetadata(slug, options);
  const petJson = await fetchJsonFromUrl(metadata.petJsonUrl, options, 'petdex_pet_json_fetch_failed');
  const manifest = petJson && typeof petJson === 'object' ? petJson : {};
  const spritesheetName = localSpritesheetName(manifest, metadata);
  const spritesheet = await fetchBufferFromUrl(metadata.spritesheetUrl, options, 'petdex_spritesheet_fetch_failed');
  const directory = path.join(root, metadata.slug);
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('invalid_pet_slug'), { statusCode: 400, code: 'invalid_pet_slug' });
  }
  if (body && body.force === true) {
    await rm(directory, { recursive: true, force: true });
  }
  await mkdir(directory, { recursive: true });
  const finalManifest = {
    ...manifest,
    id: safePetSlug(manifest.id) || metadata.slug,
    displayName: String(manifest.displayName || metadata.displayName || metadata.slug).replace(/\s+/g, ' ').trim() || metadata.slug,
    spritesheetPath: spritesheetName
  };
  await writeFile(path.join(directory, 'pet.json'), `${JSON.stringify(finalManifest, null, 2)}\n`);
  const spritesheetPath = safeChildPath(directory, spritesheetName);
  if (!spritesheetPath) {
    throw Object.assign(new Error('invalid_spritesheet_path'), { statusCode: 502, code: 'invalid_spritesheet_path' });
  }
  await writeFile(spritesheetPath, spritesheet);
  const state = await installedPetState(metadata.slug, options);
  return {
    ok: state.installed,
    slug: metadata.slug,
    installed: state.installed,
    supported: state.supported,
    skin: state.skin,
    installSource: 'petdex-direct',
    fallbackReason: cliError && cliError.code || null,
    stdout: '',
    stderr: trimCommandOutput(cliError && cliError.stderr)
  };
}

async function installGalleryPet(body, options = {}) {
  const slug = safePetSlug(body && body.slug);
  if (!slug) {
    throw Object.assign(new Error('invalid_pet_slug'), { statusCode: 400, code: 'invalid_pet_slug' });
  }
  const args = ['pets', 'install'];
  if (body && body.force === true) args.push('--force');
  if (body && body.select === true) args.push('--select');
  args.push(slug);
  let command;
  try {
    command = await runHermesPetsCommand(options, args);
  } catch (error) {
    if (shouldUseDirectPetdexInstall(error)) {
      return installPetdexPetDirect(slug, body, options, error);
    }
    throw error;
  }
  const state = await installedPetState(slug, options);
  return {
    ok: state.installed,
    slug,
    installed: state.installed,
    supported: state.supported,
    skin: state.skin,
    installSource: 'hermes-cli',
    stdout: command && command.stdout || '',
    stderr: command && command.stderr || ''
  };
}

async function removeGalleryPet(body, options = {}) {
  const slug = safePetSlug(body && body.slug);
  if (!slug) {
    throw Object.assign(new Error('invalid_pet_slug'), { statusCode: 400, code: 'invalid_pet_slug' });
  }
  const before = await installedPetState(slug, options);
  if (!before.installed) {
    return { ok: true, slug, removed: true, installed: false };
  }
  const command = await runHermesPetsCommand(options, ['pets', 'remove', slug]);
  const after = await installedPetState(slug, options);
  return {
    ok: !after.installed,
    slug,
    removed: !after.installed,
    installed: after.installed,
    stdout: command && command.stdout || '',
    stderr: command && command.stderr || ''
  };
}

function sendPetGalleryCommandError(res, headers, fallbackCode, error) {
  const status = Number(error && error.statusCode || 500);
  sendJson(res, status >= 400 && status <= 599 ? status : 500, {
    ok: false,
    error: error && error.code || fallbackCode,
    message: String(error && error.message || fallbackCode).slice(0, 1000),
    stdout: trimCommandOutput(error && error.stdout),
    stderr: trimCommandOutput(error && error.stderr)
  }, headers);
}

async function serveHermesPetAsset(res, requestPath, options = {}, headers = {}) {
  const match = requestPath.match(/^\/api\/pet\/hermes-pets\/([^/]+)\/([^/]+)$/);
  if (!match) return false;
  const root = hermesPetsRoot(options);
  const slug = safePetSlug(decodeURIComponent(match[1]));
  const fileName = path.basename(decodeURIComponent(match[2] || ''));
  const pet = await resolveHermesPet(root, slug);
  if (!pet || fileName !== path.basename(pet.spritesheet)) {
    sendJson(res, 404, { ok: false, error: 'not_found' }, headers);
    return true;
  }
  try {
    const buffer = await readFile(pet.spritesheet);
    sendBuffer(res, 200, buffer, contentTypeFor(pet.spritesheet), headers);
  } catch (_) {
    sendJson(res, 404, { ok: false, error: 'not_found' }, headers);
  }
  return true;
}

export function createServer(options = {}) {
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins || process.env.HERMES_COMPANION_ALLOWED_ORIGINS);
  const preferencePath = Object.prototype.hasOwnProperty.call(options, 'preferencePath')
    ? options.preferencePath
    : (process.env.HERMES_COMPANION_PREFERENCES_PATH || defaultPreferencePath());
  const skinSelectionPath = Object.prototype.hasOwnProperty.call(options, 'skinSelectionPath')
    ? options.skinSelectionPath
    : (Object.prototype.hasOwnProperty.call(options, 'preferencePath') && options.preferencePath === null
      ? null
      : (process.env.HERMES_COMPANION_SKIN_SELECTION_PATH || defaultPetSkinSelectionPath()));
  let preferences = normalizePreferences(options.initialPreferences || loadPreferences(preferencePath));
  let latestSnapshot = null;
  let navigationCommands = [];
  let navigationLastPollAt = 0;
  let actionCommands = [];
  let nativeHostRegistration = null;
  let petSkinSelection = normalizePetSkinSelection(
    options.initialPetSkinSelection || loadPetSkinSelection(skinSelectionPath)
  );

  // Server-attention instance state (feat/server-attention). Server mode pulls
  // attention from the remote WebUI on a poll loop; missing/invalid base or a
  // missing password downgrades to adapter mode (double guard with main.rs).
  const serverAttentionConfig = webuiConfig(options);
  // Per-instance attention bookkeeping: parallel createServer instances
  // (tests) must never share completion/observed-running state.
  const instanceAttentionState = createAttentionState();
  const instancePetStateStore = createPetStateStore();
  let effectiveAttentionMode = serverAttentionConfig.mode;
  if (serverAttentionConfig.mode === 'server') {
    if (!serverAttentionConfig.baseUrl) {
      console.error('[loopback-server] server attention mode requires a valid HERMES_COMPANION_WEBUI_REMOTE_BASE; falling back to adapter mode');
      effectiveAttentionMode = 'adapter';
    } else if (!serverAttentionConfig.password) {
      console.warn('[loopback-server] server attention mode has no webui password configured; falling back to adapter mode');
      effectiveAttentionMode = 'adapter';
    }
  }
  const serverAttentionActive = effectiveAttentionMode === 'server';
  let webuiState = serverAttentionActive ? 'online' : 'adapter';
  let webuiCookieHeader = '';
  let webuiLoginInFlight = false;
  let attentionTickInFlight = false;
  let webuiNetworkFailures = 0;
  let authBackoffUntil = 0;
  let snapshotIgnoreWarned = false;
  let serverAttentionTimer = null;
  const loginWebuiImpl = typeof options.loginWebui === 'function' ? options.loginWebui : loginWebuiRemote;
  const webuiFetchImpl = typeof options.webuiFetch === 'function' ? options.webuiFetch : fetchViaWebuiBase;
  const webuiPostImpl = typeof options.webuiPost === 'function' ? options.webuiPost : postViaWebuiBase;

  async function loginWebui() {
    webuiLoginInFlight = true;
    try {
      const result = await loginWebuiImpl(serverAttentionConfig);
      if (result && result.ok === true) {
        if (result.cookieHeader) webuiCookieHeader = String(result.cookieHeader);
        return { ok: true };
      }
      return { ok: false, reason: result && result.reason === 'auth' ? 'auth' : 'network' };
    } finally {
      webuiLoginInFlight = false;
    }
  }

  // GET fetcher used by the poll loop and buildAttention detail fetches.
  // options.webuiFetch overrides it for tests.
  function webuiFetch(path, ctx = {}) {
    return webuiFetchImpl(path, {
      base: serverAttentionConfig.base,
      cookieHeader: webuiCookieHeader,
      timeoutMs: ctx.timeoutMs || WEBUI_FETCH_TIMEOUT_MS
    });
  }

  // POST fetcher used by the server-attention action path (approval/clarify
  // respond) to call the VPS API directly. Mirrors webuiFetch's cookie jar
  // and timeout; options.webuiPost overrides it for tests. Returns
  // { ok, status, json, needRelogin }.
  function webuiPost(path, body, ctx = {}) {
    return webuiPostImpl(path, body, {
      base: serverAttentionConfig.base,
      cookieHeader: webuiCookieHeader,
      timeoutMs: ctx.timeoutMs || WEBUI_FETCH_TIMEOUT_MS
    });
  }

  // One poll tick: login when needed, pull /api/sessions, rebuild attention
  // into latestSnapshot. Auth failures (401/429) enter a 30s backoff and set
  // state=auth_error WITHOUT counting towards the offline limit; network
  // failures count 3x -> offline. Tests drive this directly via
  // server.tickServerAttention().
  async function tickServerAttention() {
    if (!serverAttentionActive || attentionTickInFlight) return;
    attentionTickInFlight = true;
    try {
      if (Date.now() < authBackoffUntil) return;

      if (!webuiCookieHeader) {
        const login = await loginWebui();
        if (!login.ok) {
          if (login.reason === 'auth') {
            webuiState = 'auth_error';
            authBackoffUntil = Date.now() + WEBUI_AUTH_BACKOFF_MS;
          } else {
            webuiNetworkFailures += 1;
            if (webuiNetworkFailures >= WEBUI_NETWORK_FAILURE_LIMIT) webuiState = 'offline';
          }
          return;
        }
        webuiNetworkFailures = 0;
      }

      let response;
      try {
        response = await webuiFetch('/api/sessions');
      } catch (_) {
        webuiNetworkFailures += 1;
        if (webuiNetworkFailures >= WEBUI_NETWORK_FAILURE_LIMIT) webuiState = 'offline';
        return;
      }
      if (!response) {
        webuiNetworkFailures += 1;
        if (webuiNetworkFailures >= WEBUI_NETWORK_FAILURE_LIMIT) webuiState = 'offline';
        return;
      }
      if (response.status === 401 || response.status === 429) {
        // Session expired or throttled: drop the cookie and back off, but never
        // present this as "offline" — bubbles distinguish auth_error copy.
        webuiCookieHeader = '';
        webuiState = 'auth_error';
        authBackoffUntil = Date.now() + WEBUI_AUTH_BACKOFF_MS;
        return;
      }
      if (!response.ok || !response.data) {
        webuiNetworkFailures += 1;
        if (webuiNetworkFailures >= WEBUI_NETWORK_FAILURE_LIMIT) webuiState = 'offline';
        return;
      }
      const rows = Array.isArray(response.data.sessions) ? response.data.sessions : [];
      const attention = await serverBuildAttention(rows, {
        fetchWebui: webuiFetch,
        store: instancePetStateStore,
        state: instanceAttentionState
      });
      if (Array.isArray(attention)) {
        latestSnapshot = {
          timestamp: new Date().toISOString(),
          reason: 'poll',
          companion: { attention }
        };
      }
      webuiNetworkFailures = 0;
      webuiState = 'online';
    } finally {
      attentionTickInFlight = false;
    }
  }

  function stopServerAttention() {
    if (serverAttentionTimer) {
      clearInterval(serverAttentionTimer);
      serverAttentionTimer = null;
    }
  }

  function preferenceResponse() {
    return { ok: true, ...preferences, server_time: Date.now() / 1000 };
  }

  function petCapabilities() {
    return {
      ok: true,
      pet_pack_contract_version: PET_PACK_CONTRACT_VERSION,
      service: SERVICE_NAME,
      version: VERSION,
      pet_model: {
        user_facing_selection: 'pet_skin',
        pack_types: ['classic_skin', 'custom_display_pack'],
        default_pack_type: 'classic_skin',
        custom_display_packs: false
      },
      endpoints: {
        health: '/health',
        snapshot: '/api/webui/snapshot',
        attention: '/api/pet/attention',
        skins: '/api/pet/skins',
        capabilities: '/api/pet/capabilities',
        open_session: '/api/pet/open_session',
        preferences: '/api/pet/preference'
      },
      attention: {
        statuses: ['running', 'ready', 'action_required'],
        sources: ['webui-extension-snapshot', 'empty', 'stale', 'unloaded'],
        stale_after_ms: PET_SNAPSHOT_ATTENTION_TTL_MS
      },
      capabilities: {
        read_attention: true,
        read_snapshot: true,
        read_skins: true,
        open_session: true,
        draft_reply: true,
        direct_send: Boolean(preferences.allow_direct_send),
        inline_action_responses: Boolean(preferences.allow_inline_action_responses)
      },
      server_time: Date.now() / 1000
    };
  }

  function updatePreferences(body) {
    const next = { ...preferences };
    for (const key of ['enabled', 'allow_direct_send', 'allow_inline_action_responses']) {
      if (body && typeof body[key] === 'boolean') next[key] = body[key];
    }
    preferences = normalizePreferences(next);
    savePreferences(preferencePath, preferences);
    return preferenceResponse();
  }

  function petSkinSelectionResponse(since = 0) {
    const sinceMs = Number(since || 0);
    const changed = Number(petSkinSelection.updated_at_ms || 0) > sinceMs;
    return {
      ok: true,
      changed,
      skin_id: changed ? petSkinSelection.skin_id : null,
      updated_at_ms: petSkinSelection.updated_at_ms,
      updated_at: petSkinSelection.updated_at,
      server_time: Date.now() / 1000
    };
  }

  async function updatePetSkinSelection(body) {
    const skinId = safeSkinId(body && (body.skin_id || body.skinId));
    if (!skinId) {
      throw Object.assign(new Error('invalid_skin_id'), { statusCode: 400, code: 'invalid_skin_id' });
    }
    const skins = await allPetSkins(options);
    if (!skins.some((skin) => skin.id === skinId)) {
      throw Object.assign(new Error('skin_not_found'), { statusCode: 404, code: 'skin_not_found' });
    }
    const now = Date.now();
    petSkinSelection = {
      skin_id: skinId,
      updated_at_ms: now,
      updated_at: now / 1000
    };
    try {
      savePetSkinSelection(skinSelectionPath, petSkinSelection);
    } catch (error) {
      console.warn('Failed to save pet skin selection', error);
    }
    return {
      ok: true,
      changed: true,
      skin_id: petSkinSelection.skin_id,
      updated_at_ms: petSkinSelection.updated_at_ms,
      updated_at: petSkinSelection.updated_at,
      server_time: now / 1000
    };
  }

  function runtimeStatus(now = Date.now()) {
    const snapshotState = snapshotAttentionState(latestSnapshot, now);
    const snapshotMs = snapshotTimestampMs(latestSnapshot);
    const bridgeConnected = snapshotState === 'fresh';
    const nativeHostRunning = isProcessAlive(nativeHostRegistration && nativeHostRegistration.pid);
    return {
      sidecar: 'running',
      native_host: nativeHostRunning
        ? 'running'
        : (nativeHostRegistration ? 'stopped' : 'not_registered'),
      bridge: bridgeConnected ? 'connected' : (snapshotState === 'empty' ? 'waiting' : snapshotState),
      last_seen_at: snapshotMs > 0 ? snapshotMs / 1000 : null,
      webui_origin: latestWebuiOrigin(latestSnapshot),
      native_host_registered_at: nativeHostRegistration ? nativeHostRegistration.registered_at : null
    };
  }

  function trimNavigationCommands(now = Date.now()) {
    const cutoff = now - PET_NAVIGATION_TTL_MS;
    navigationCommands = navigationCommands
      .filter((command) => Number(command.created_at_ms || 0) >= cutoff)
      .slice(-PET_NAVIGATION_MAX_COMMANDS);
  }

  function trimActionCommands(now = Date.now()) {
    const cutoff = now - PET_ACTION_TTL_MS;
    actionCommands = actionCommands
      .filter((command) => Number(command.created_at_ms || 0) >= cutoff)
      .slice(-PET_ACTION_MAX_COMMANDS);
  }

  function nextNavigationCommand(since = '') {
    const pending = navigationCommands.filter((command) => !command.acked_at_ms);
    if (!pending.length) return null;
    if (!since) return { ...pending[0] };
    let seenSince = false;
    for (const command of navigationCommands) {
      if (command.id === since) {
        seenSince = true;
        continue;
      }
      if (seenSince && !command.acked_at_ms) return { ...command };
    }
    return navigationCommands.some((command) => command.id === since) ? null : { ...pending[pending.length - 1] };
  }

  function nextActionCommand(since = '') {
    const pending = actionCommands.filter((command) => !command.acked_at_ms);
    if (!pending.length) return null;
    if (!since) return { ...pending[0] };
    let seenSince = false;
    for (const command of actionCommands) {
      if (command.id === since) {
        seenSince = true;
        continue;
      }
      if (seenSince && !command.acked_at_ms) return { ...command };
    }
    return actionCommands.some((command) => command.id === since) ? null : { ...pending[pending.length - 1] };
  }

  function ackNavigationCommand(commandId) {
    const id = String(commandId || '').trim();
    if (!id) return false;
    const command = navigationCommands.find((item) => item.id === id);
    if (!command) return false;
    command.acked_at_ms = Date.now();
    return true;
  }

  function ackActionCommand(body) {
    const id = String(body && body.id || '').trim();
    if (!id) return false;
    const command = actionCommands.find((item) => item.id === id);
    if (!command) return false;
    command.acked_at_ms = Date.now();
    command.ok = Boolean(body.ok);
    command.status = Number(body.status || (command.ok ? 200 : 500));
    command.result = body.result && typeof body.result === 'object' ? body.result : null;
    command.error = String(body.error || '');
    return true;
  }

  function bridgeRecentlyPolled() {
    return Date.now() - navigationLastPollAt <= PET_BRIDGE_POLL_FRESH_MS;
  }

  async function waitForNavigationAck(commandId, timeoutMs = 1600) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const command = navigationCommands.find((item) => item.id === commandId);
      if (!command) return false;
      if (command.acked_at_ms) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async function waitForActionAck(commandId, timeoutMs = PET_ACTION_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const command = actionCommands.find((item) => item.id === commandId);
      if (!command) return null;
      if (command.acked_at_ms) return { ...command };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  function queuePetSessionNavigation(body) {
    const sessionId = safeSessionId(body && body.session_id);
    if (!sessionId) throw Object.assign(new Error('session_id is required'), { statusCode: 400 });
    // P2-14: the adapter page is usually absent in server-attention mode, so
    // fall back to the remote WebUI base when no loopback origin is known.
    // In adapter mode the configured WebUI base is the last-resort origin so
    // session navigation keeps working without a live snapshot (a browser tab
    // is opened/focused to the session URL). Only a complete lack of any
    // lawful URL yields 409 webui_snapshot_unavailable.
    const origin = latestWebuiOrigin(latestSnapshot)
      || (serverAttentionActive && serverAttentionConfig.baseUrl ? serverAttentionConfig.baseUrl.origin : null)
      || (!serverAttentionActive && configuredWebuiUrl(options) ? configuredWebuiUrl(options).origin : null);
    if (!origin) throw Object.assign(new Error('webui_snapshot_unavailable'), { statusCode: 409 });
    const targetUrl = `${origin}/session/${encodeURIComponent(sessionId)}`;
    const now = Date.now();
    const requestedAutosend = Boolean(body && body.autosend);
    const autosendAllowed = Boolean(preferences.allow_direct_send);
    const command = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      session_id: sessionId,
      draft: String(body && body.draft || ''),
      autosend: requestedAutosend && autosendAllowed,
      autosend_requested: requestedAutosend,
      autosend_blocked: requestedAutosend && !autosendAllowed,
      url: targetUrl,
      created_at: now / 1000,
      created_at_ms: now
    };
    navigationCommands.push(command);
    trimNavigationCommands(now);
    return command;
  }

  function queuePetAction(type, body) {
    const actionType = String(type || '').trim();
    const sessionId = safeSessionId(body && body.session_id);
    if (!sessionId) throw Object.assign(new Error('session_id is required'), { statusCode: 400 });
    if (!['approval.respond', 'clarify.respond'].includes(actionType)) {
      throw Object.assign(new Error('unsupported pet action'), { statusCode: 400 });
    }
    if (!preferences.allow_inline_action_responses) {
      throw Object.assign(new Error('inline_action_responses_disabled'), { statusCode: 403 });
    }
    const now = Date.now();
    const command = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      type: actionType,
      session_id: sessionId,
      body: body && typeof body === 'object' ? { ...body, session_id: sessionId } : { session_id: sessionId },
      created_at: now / 1000,
      created_at_ms: now
    };
    actionCommands.push(command);
    trimActionCommands(now);
    return command;
  }

  async function handleQueuedPetAction(res, headers, type, body) {
    // P1-2: the inline-action switch gates BOTH server and adapter modes so
    // that flipping server attention on never bypasses the user's opt-in.
    // (queuePetAction re-checks this for the adapter path as defence-in-depth.)
    if (!preferences.allow_inline_action_responses) {
      sendJson(res, 403, { ok: false, error: 'inline_action_responses_disabled' }, headers);
      return;
    }

    if (serverAttentionActive) {
      // Server mode: call the VPS approval/clarify API directly via webuiPost,
      // bypassing the adapter action queue + ack wait. The bubbles POST body
      // (session_id/choice/approval_id or session_id/response/clarify_id) is
      // forwarded verbatim; extra fields are ignored by the VPS.
      const actionPath = type === 'clarify.respond'
        ? '/api/clarify/respond'
        : '/api/approval/respond';
      let result;
      try {
        result = await webuiPost(actionPath, body);
      } catch (_) {
        // Network failure (DNS/TCP/timeout): surface as 502, no VPS body.
        sendJson(res, 502, { ok: false, error: 'webui_action_network', server_executed: true }, headers);
        return;
      }
      if (!result) {
        sendJson(res, 502, { ok: false, error: 'webui_action_network', server_executed: true }, headers);
        return;
      }
      // 401: cookie expired — re-login once and retry, then return whatever
      // the retry yields (including a second 401, which is surfaced as-is).
      if (result.needRelogin || result.status === 401) {
        const login = await loginWebui();
        if (login.ok) {
          let retry;
          try {
            retry = await webuiPost(actionPath, body);
          } catch (_) {
            sendJson(res, 502, { ok: false, error: 'webui_action_network', server_executed: true }, headers);
            return;
          }
          if (retry) {
            sendJson(res, retry.status, {
              ...((retry.json && typeof retry.json === 'object') ? retry.json : {}),
              ok: Boolean(retry.ok),
              server_executed: true
            }, headers);
            return;
          }
        }
        // Login failed or retry threw: surface the original 401 (or 502).
        sendJson(res, result.status, {
          ...((result.json && typeof result.json === 'object') ? result.json : {}),
          ok: false,
          server_executed: true
        }, headers);
        return;
      }
      // P3-1: VPS 4xx (e.g. 400 bad choice) is passed through unchanged; only
      // network failures (caught above) become 502. 2xx is passed through with
      // ok forced true and server_executed=true.
      sendJson(res, result.status, {
        ...((result.json && typeof result.json === 'object') ? result.json : {}),
        ok: Boolean(result.ok),
        server_executed: true
      }, headers);
      return;
    }

    // Adapter mode: original queue + ack wait. queuePetAction re-validates
    // the switch + session_id and pushes onto actionCommands.
    const command = queuePetAction(type, body);
    const completed = await waitForActionAck(command.id);
    if (!completed) {
      sendJson(res, 504, {
        ok: false,
        error: 'webui_action_timeout',
        queued: true,
        command: { id: command.id, type: command.type, session_id: command.session_id }
      }, headers);
      return;
    }
    const status = Number(completed.status || (completed.ok ? 200 : 500));
    sendJson(res, status >= 100 && status <= 599 ? status : (completed.ok ? 200 : 500), {
      ...(completed.result && typeof completed.result === 'object' ? completed.result : {}),
      ok: Boolean(completed.ok),
      error: completed.error || (completed.ok ? undefined : 'webui_action_failed'),
      queued: true,
      command: { id: command.id, type: command.type, session_id: command.session_id }
    }, headers);
  }

  const server = http.createServer(async (req, res) => {
    const headers = corsHeaders(req, allowedOrigins);

    if (req.method === 'OPTIONS') {
      res.writeHead(Object.keys(headers).length ? 204 : 403, headers);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');

    try {
      if (req.method === 'HEAD') {
        if (url.pathname === '/health') {
          sendHead(res, 200, 'application/json; charset=utf-8', 0, headers);
          return;
        }
        if (url.pathname === '/' || url.pathname === '/pet' || url.pathname === '/pet/' || url.pathname === '/pet/bubbles' || url.pathname === '/pet/bubbles/' || url.pathname === '/pet/gallery' || url.pathname === '/pet/gallery/') {
          const fileName = url.pathname.startsWith('/pet/bubbles')
            ? 'bubbles.html'
            : (url.pathname.startsWith('/pet/gallery') ? 'pet-gallery.html' : 'pet.html');
          const info = await stat(path.join(DESKTOP_WEB_ROOT, fileName));
          sendHead(res, 200, 'text/html; charset=utf-8', info.size, headers);
          return;
        }
        if (url.pathname.startsWith('/desktop-pet/')) {
          const target = safeStaticPath(DESKTOP_WEB_ROOT, url.pathname.slice('/desktop-pet/'.length));
          if (!target) {
            sendHead(res, 404, 'application/json; charset=utf-8', 0, headers);
            return;
          }
          try {
            const info = await stat(target);
            sendHead(res, info.isFile() ? 200 : 404, contentTypeFor(target), info.isFile() ? info.size : 0, headers);
          } catch (_) {
            sendHead(res, 404, 'application/json; charset=utf-8', 0, headers);
          }
          return;
        }
        if (url.pathname.startsWith('/extensions/')) {
          const target = safeStaticPath(EXTENSION_ROOT, url.pathname.slice('/extensions/'.length));
          if (!target) {
            sendHead(res, 404, 'application/json; charset=utf-8', 0, headers);
            return;
          }
          try {
            const info = await stat(target);
            sendHead(res, info.isFile() ? 200 : 404, contentTypeFor(target), info.isFile() ? info.size : 0, headers);
          } catch (_) {
            sendHead(res, 404, 'application/json; charset=utf-8', 0, headers);
          }
          return;
        }
        sendHead(res, 404, 'application/json; charset=utf-8', 0, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          status: 'ok',
          service: SERVICE_NAME,
          name: DISPLAY_NAME,
          version: VERSION,
          sidecar: {
            type: 'loopback',
            health_path: '/health'
          },
          runtime: runtimeStatus()
        }, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/webui/snapshot') {
        sendJson(res, 200, { ok: true, snapshot: latestSnapshot }, headers);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/webui/snapshot') {
        // Parse first so invalid JSON still yields 400 in both modes (R3);
        // server mode then ignores the adapter snapshot — the poll loop owns
        // latestSnapshot there (adapter file stays untouched).
        const snapshot = await readJson(req);
        if (serverAttentionActive) {
          if (!snapshotIgnoreWarned) {
            console.warn('[loopback-server] server attention mode ignores adapter snapshots');
            snapshotIgnoreWarned = true;
          }
          sendJson(res, 200, { ok: true }, headers);
          return;
        }
        latestSnapshot = snapshot;
        sendJson(res, 200, { ok: true }, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/pet/attention') {
        if (serverAttentionActive) {
          // Server mode: reuse the values the pet page keeps locally.
          // viewed_counts is legitimate; completion_unread currently has no
          // writer outside the WebUI page — parsed for parity (documented).
          try {
            instancePetStateStore.viewedCounts = JSON.parse(url.searchParams.get('viewed_counts') || '{}') || {};
          } catch (_) { /* keep previous */ }
          try {
            instancePetStateStore.completionUnread = JSON.parse(url.searchParams.get('completion_unread') || '{}') || {};
          } catch (_) { /* keep previous */ }
        }
        const attentionState = snapshotAttentionState(latestSnapshot);
        const fresh = attentionState === 'fresh';
        sendJson(res, 200, {
          ok: true,
          sessions: latestAttention(latestSnapshot),
          source: fresh ? (serverAttentionActive ? 'server-poll' : 'webui-extension-snapshot') : attentionState,
          server_time: Date.now() / 1000
        }, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/pet/connection') {
        sendJson(res, 200, {
          ok: true,
          mode: effectiveAttentionMode,
          state: serverAttentionActive ? webuiState : 'adapter'
        }, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/pet/skins') {
        sendJson(res, 200, { ok: true, skins: await allPetSkins(options) }, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/pet/hermes-pets/')) {
        await serveHermesPetAsset(res, url.pathname, options, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/pet/gallery/preview/')) {
        await servePetGalleryPreview(res, url.pathname, options, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/pet/gallery') {
        try {
          sendJson(res, 200, await petGalleryResponse(url, options), headers);
        } catch (error) {
          sendPetGalleryCommandError(res, headers, 'pet_gallery_failed', error);
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pet/gallery/install') {
        try {
          sendJson(res, 200, await installGalleryPet(await readJson(req), options), headers);
        } catch (error) {
          sendPetGalleryCommandError(res, headers, 'pet_install_failed', error);
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pet/gallery/remove') {
        try {
          sendJson(res, 200, await removeGalleryPet(await readJson(req), options), headers);
        } catch (error) {
          sendPetGalleryCommandError(res, headers, 'pet_remove_failed', error);
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/pet/capabilities') {
        sendJson(res, 200, petCapabilities(), headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/pet/navigation') {
        navigationLastPollAt = Date.now();
        trimNavigationCommands();
        const since = String(url.searchParams.get('since') || '');
        sendJson(res, 200, { ok: true, command: nextNavigationCommand(since), server_time: Date.now() / 1000 }, headers);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pet/navigation_ack') {
        const body = await readJson(req);
        const ok = ackNavigationCommand(body && body.id);
        sendJson(res, ok ? 200 : 404, { ok, server_time: Date.now() / 1000 }, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/pet/actions') {
        trimActionCommands();
        const since = String(url.searchParams.get('since') || '');
        sendJson(res, 200, { ok: true, command: nextActionCommand(since), server_time: Date.now() / 1000 }, headers);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pet/action_ack') {
        const body = await readJson(req);
        const ok = ackActionCommand(body);
        sendJson(res, ok ? 200 : 404, { ok, server_time: Date.now() / 1000 }, headers);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/approval/respond') {
        await handleQueuedPetAction(res, headers, 'approval.respond', await readJson(req));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/clarify/respond') {
        await handleQueuedPetAction(res, headers, 'clarify.respond', await readJson(req));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pet/register') {
        const body = await readJson(req);
        const pid = Number(body && body.pid || 0);
        const now = Date.now();
        nativeHostRegistration = {
          pid: Number.isInteger(pid) && pid > 0 ? pid : null,
          base_url: String(body && body.base_url || ''),
          registered_at: now / 1000,
          registered_at_ms: now
        };
        sendJson(res, 200, { ok: true, server_time: Date.now() / 1000 }, headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/pet/preference') {
        sendJson(res, 200, preferenceResponse(), headers);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pet/preference') {
        sendJson(res, 200, updatePreferences(await readJson(req)), headers);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/pet/skin_selection') {
        sendJson(res, 200, petSkinSelectionResponse(url.searchParams.get('since')), headers);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pet/skin_selection') {
        try {
          sendJson(res, 200, await updatePetSkinSelection(await readJson(req)), headers);
        } catch (error) {
          sendPetGalleryCommandError(res, headers, 'pet_skin_selection_failed', error);
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pet/open_webui') {
        await readJson(req);
        // Server mode prefers the remote WebUI base over the local dev default
        // when no adapter snapshot is available (P2-14).
        const target = latestWebuiUrl(latestSnapshot)
          || (serverAttentionActive && serverAttentionConfig.baseUrl ? serverAttentionConfig.baseUrl : null)
          || configuredWebuiUrl(options);
        if (!target) {
          sendJson(res, 409, { ok: false, error: 'webui_snapshot_unavailable' }, headers);
          return;
        }
        const focused = await focusOrOpenBrowserUrl(target.href, target.origin, options);
        sendJson(res, 200, {
          ok: true,
          opened: focused.opened,
          focused: focused.focused,
          reused: focused.reused,
          url: target.href
        }, headers);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pet/open_session') {
        const body = await readJson(req);
        const command = queuePetSessionNavigation(body);
        const origin = latestWebuiOrigin(latestSnapshot)
          || (serverAttentionActive && serverAttentionConfig.baseUrl ? serverAttentionConfig.baseUrl.origin : null)
          || (!serverAttentionActive && configuredWebuiUrl(options) ? configuredWebuiUrl(options).origin : null);
        if (serverAttentionActive) {
          // Server mode: an adapter page is usually absent, so historically
          // this skipped the bridge ack wait entirely and opened/focused a
          // browser tab. However, when a WebUI bridge IS active (it recently
          // polled /api/pet/navigation), prefer reusing that existing tab via
          // the navigation ack BEFORE falling back to opening a new browser
          // tab — same priority as adapter mode. Draft/autosend payloads
          // still follow the server-mode semantic: they are silently dropped
          // unless the bridge actually acks the command (no hard 504).
          const hasActiveBridge = bridgeRecentlyPolled();
          let consumed = false;
          if (hasActiveBridge) {
            consumed = await waitForNavigationAck(command.id);
          }
          if (consumed) {
            sendJson(res, 200, {
              ok: true,
              consumed: true,
              opened: false,
              focused: false,
              reused: false,
              queued: true,
              command,
              url: command.url,
              server_executed: true
            }, headers);
            return;
          }
          // No fresh bridge or ack not consumed: fall back to opening/focusing
          // a browser tab. Draft/autosend payloads are silently dropped (P2-1
          // accepted: the user lands on the session page and can send from
          // there).
          const focused = await focusOrOpenBrowserUrl(command.url, origin, options);
          sendJson(res, 200, {
            ok: true,
            consumed: false,
            opened: focused.opened,
            focused: focused.focused,
            reused: focused.reused,
            queued: false,
            command,
            url: command.url,
            server_executed: true
          }, headers);
          return;
        }
        // Adapter mode: when an active WebUI bridge recently polled the
        // navigation queue, prefer waiting for the bridge to ack the command
        // BEFORE falling back to opening/focusing a browser tab. This keeps
        // the user's existing WebUI tab as the primary navigation target and
        // only opens a new tab when the bridge cannot consume the command.
        const needsBridgeAck = Boolean(command.draft || command.autosend);
        let consumed = false;
        if (needsBridgeAck) {
          // Draft/autosend payloads must route through the bridge with the
          // long timeout; a missed ack here is a hard 504 (the draft payload
          // must not be silently dropped).
          consumed = await waitForNavigationAck(command.id, PET_ACTION_WAIT_MS);
        } else if (bridgeRecentlyPolled()) {
          // Plain navigation with an active bridge: wait briefly for the ack
          // (default 1600ms). The request stays pending here while the
          // adapter polls /api/pet/navigation and acks the queued command.
          consumed = await waitForNavigationAck(command.id);
        }
        if (needsBridgeAck && !consumed) {
          sendJson(res, 504, {
            ok: false,
            error: 'webui_navigation_timeout',
            consumed: false,
            opened: false,
            queued: true,
            focused: false,
            reused: false,
            command,
            url: command.url
          }, headers);
          return;
        }
        // Bridge consumed the command: no browser open/focus fallback.
        if (consumed) {
          sendJson(res, 200, {
            ok: true,
            consumed: true,
            opened: false,
            focused: false,
            reused: false,
            queued: true,
            command,
            url: command.url
          }, headers);
          return;
        }
        // No fresh bridge or ack not consumed: fall back to opening/focusing
        // a browser tab. A plain (no-draft) timeout falls through here rather
        // than returning a 504.
        const focused = await focusOrOpenBrowserUrl(command.url, origin, options);
        sendJson(res, 200, {
          ok: true,
          consumed: false,
          opened: focused.opened,
          queued: true,
          focused: focused.focused,
          reused: focused.reused,
          command,
          url: command.url
        }, headers);
        return;
      }

      // These pages are loaded by the Tauri native windows. The WebUI adapter
      // does not inject them into the Hermes WebUI browser page.
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/pet' || url.pathname === '/pet/')) {
        const html = await readFile(path.join(DESKTOP_WEB_ROOT, 'pet.html'), 'utf8');
        sendText(res, 200, html, 'text/html; charset=utf-8', headers);
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/pet/bubbles' || url.pathname === '/pet/bubbles/')) {
        const html = await readFile(path.join(DESKTOP_WEB_ROOT, 'bubbles.html'), 'utf8');
        sendText(res, 200, html, 'text/html; charset=utf-8', headers);
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/pet/gallery' || url.pathname === '/pet/gallery/')) {
        const html = await readFile(path.join(DESKTOP_WEB_ROOT, 'pet-gallery.html'), 'utf8');
        sendText(res, 200, html, 'text/html; charset=utf-8', headers);
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/desktop-pet/')) {
        await serveStatic(res, DESKTOP_WEB_ROOT, url.pathname.slice('/desktop-pet/'.length), headers);
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/extensions/')) {
        await serveStatic(res, EXTENSION_ROOT, url.pathname.slice('/extensions/'.length), headers);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not_found' }, headers);
    } catch (error) {
      const status = error.statusCode || 500;
      sendJson(res, status, {
        ok: false,
        error: status >= 500 ? 'internal_error' : error.message
      }, headers);
    }
  });

  // Test hooks so tests can drive the poll loop deterministically
  // (await server.tickServerAttention()) instead of real timers.
  server.tickServerAttention = tickServerAttention;
  server.stopServerAttention = stopServerAttention;

  // Server mode: start the unref'd poll loop (won't hold the process open).
  // tests pass attentionAutoStart:false and drive ticks manually.
  if (serverAttentionActive && options.attentionAutoStart !== false) {
    const pollIntervalMs = Number(options.pollIntervalMs) > 0
      ? Number(options.pollIntervalMs)
      : WEBUI_DEFAULT_POLL_INTERVAL_MS;
    serverAttentionTimer = setInterval(() => {
      tickServerAttention().catch(() => {});
    }, pollIntervalMs);
    if (typeof serverAttentionTimer.unref === 'function') serverAttentionTimer.unref();
    tickServerAttention().catch(() => {});
  }

  return server;
}

export function startServer(options = {}) {
  const host = options.host || process.env.HERMES_COMPANION_HOST || '127.0.0.1';
  const port = normalizePort(options.port ?? process.env.HERMES_COMPANION_PORT);
  const server = createServer(options);

  server.listen(port, host, () => {
    const address = server.address();
    const bound = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${host}:${port}`;
    console.log(`${SERVICE_NAME} listening on http://${bound}`);
  });

  return server;
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryUrl) {
  startServer();
}
