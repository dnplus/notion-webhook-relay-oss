import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, webcrypto } from 'node:crypto';
import worker from '../src/index.js';
import { DEFAULTS as BASE } from '../src/config.js';

// Fake, non-real IDs used only in tests.
const DEFAULTS = {
  ...BASE,
  TASKS_DATABASE_ID: '00000000-0000-4000-8000-0000000000aa',
  TASKS_DATA_SOURCE_ID: '00000000-0000-4000-8000-0000000000bb',
  SELF_BOT_IDS: '00000000-0000-4000-8000-0000000000cc',
};

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const env = {
  GROK_BOT_WEBHOOK_URL: 'https://routine.example/comments',
  GROK_BOT_WEBHOOK_AUTH: 'routine-secret-marker',
  NOTION_API_TOKEN: 'notion-secret-marker',
  TASKS_DATABASE_ID: DEFAULTS.TASKS_DATABASE_ID,
  TASKS_DATA_SOURCE_ID: DEFAULTS.TASKS_DATA_SOURCE_ID,
  SELF_BOT_IDS: DEFAULTS.SELF_BOT_IDS,
};
const event = () => ({
  id: 'event-1', type: 'page.properties_updated', timestamp: '2026-10-08T00:00:00Z',
  entity: { id: 'page-1', type: 'page' }, authors: [{ id: 'human-1', type: 'person' }],
  attempt_number: 1, data: { updated_properties: [DEFAULTS.STATUS_PROPERTY_ID] },
});
const page = () => ({
  parent: { type: 'database_id', database_id: DEFAULTS.TASKS_DATABASE_ID },
  url: 'https://www.notion.so/page-1', properties: {
    Name: { type: 'title', title: [{ plain_text: '測試 ' }, { plain_text: 'task' }] },
    Status: { id: DEFAULTS.STATUS_PROPERTY_ID, type: 'status', status: { name: 'Ready for AI' } },
  },
});
const sign = (bytes, token = 'verification-secret-marker') =>
  `sha256=${createHmac('sha256', token).update(bytes).digest('hex')}`;

async function invoke({ body = JSON.stringify(event()), bindings = {}, headers = {}, notionPage = page(),
  notionStatus = 200, upstreamStatus = 202, method = 'POST', fail, notion } = {}) {
  const calls = [];
  const logs = [];
  const warnings = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    if (fail === 'all' || (fail === 'notion' && url.startsWith('https://api.notion.com/'))) throw new Error('secret-marker');
    if (notion && url.startsWith('https://api.notion.com/')) {
      const r = notion(url);
      if (r instanceof Error) throw r;
      return Response.json(r.body, { status: r.status ?? 200 });
    }
    if (url.startsWith('https://api.notion.com/')) return Response.json(notionPage, { status: notionStatus });
    return new Response([204, 205, 304].includes(upstreamStatus) ? null : 'upstream result', {
      status: upstreamStatus, headers: { 'Content-Type': 'text/plain' },
    });
  };
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{"msg":"notion_webhook"')) logs.push(args);
    else if (typeof args[0] === 'string' && args[0].startsWith('{"msg":"notion_webhook_warning"')) warnings.push(JSON.parse(args[0]));
    else originalLog(...args);
  };
  try {
    const response = await worker.fetch(new Request('https://relay.example/', {
      method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body }),
    }), { ...env, ...bindings });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].length, 1);
    assert.equal(logs[0][0].includes('\n'), false);
    const log = JSON.parse(logs[0][0]);
    for (const key of ['msg', 'worker_received_at', 'event_type', 'notion_event_id',
      'notion_event_timestamp', 'page_id', 'signature', 'action', 'reason', 'upstream_status']) assert.ok(key in log, key);
    assert.equal(log.msg, 'notion_webhook');
    for (const token of ['routine-secret-marker', 'notion-secret-marker', 'verification-secret-marker',
      'second-secret-marker', 'private-body-marker']) assert.equal(logs[0][0].includes(token), false);
    for (const w of warnings) for (const token of ['routine-secret-marker', 'verification-secret-marker'])
      assert.equal(JSON.stringify(w).includes(token), false);
    return { response, calls, log, warnings };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}
async function dropped(options, reason, status = 200, callCount = 0) {
  const result = await invoke(options);
  assert.equal(result.response.status, status);
  assert.deepEqual(await result.response.json(), { ok: true, forwarded: false, reason });
  assert.equal(result.calls.length, callCount);
  assert.equal(result.log.reason, reason);
  return result;
}

describe('Notion webhook relay', { concurrency: false }, () => {
for (const type of ['unknown.event', 'page.created']) {
  test(`${type}: exact bytes, auth, signature, headers and upstream status`, async () => {
    const body = Buffer.from(` { "type": "${type}", "timestamp":"2026-10-08T00:00:00Z", "data":"留言 private-body-marker" }\r\n`);
    const signature = sign(body);
    const { response, calls, log } = await invoke({ body, headers: { 'X-Notion-Signature': signature }, upstreamStatus: 418 });
    assert.equal(response.status, 418);
    assert.equal(response.headers.get('X-Relay-Upstream-Status'), '418');
    assert.equal(await response.text(), 'upstream result');
    assert.equal(response.headers.get('Content-Type'), 'text/plain');
    assert.equal(calls.length, 1);
    assert.deepEqual(Buffer.from(calls[0].body), body);
    assert.equal(calls[0].headers.Authorization, 'Bearer routine-secret-marker');
    assert.equal(calls[0].headers['X-Notion-Signature'], signature);
    assert.equal(calls[0].headers['X-Relay-Event-Type'], type);
    assert.equal(calls[0].headers['X-Relay-Received-At'], log.worker_received_at);
    assert.equal(calls[0].headers['X-Relay-Notion-Event-Timestamp'], log.notion_event_timestamp);
    assert.equal(log.signature, 'skipped_no_token');
    assert.equal(log.action, 'forwarded');
    assert.equal(log.latency_ms, Date.parse(log.worker_received_at) - Date.parse(log.notion_event_timestamp));
  });
}
test('valid signature forwards signed original bytes', async () => {
  const body = Buffer.from('{ "type": "unknown.event", "text": "中文" }\n');
  const { response, calls, log } = await invoke({ body, bindings: { NOTION_WEBHOOK_VERIFICATION_TOKEN: 'verification-secret-marker' },
    headers: { 'X-Notion-Signature': sign(body) } });
  assert.equal(response.status, 202);
  assert.equal(log.signature, 'valid');
  assert.deepEqual(Buffer.from(calls[0].body), body);
});
for (const signature of [undefined, `sha256=${'0'.repeat(64)}`, 'sha256=bad']) {
  test(`signature rejection: ${signature ?? 'missing'}`, async () => {
    const { response, calls, log } = await invoke({ bindings: { NOTION_WEBHOOK_VERIFICATION_TOKEN: 'verification-secret-marker' },
      headers: signature ? { 'X-Notion-Signature': signature } : {} });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
    assert.equal(log.signature, 'invalid');
    assert.equal(log.action, 'rejected');
  });
}
describe('signature verification (4 cases)', () => {
  const secret = { NOTION_WEBHOOK_VERIFICATION_TOKEN: 'verification-secret-marker' };
  const body = Buffer.from('{"type":"unknown.event","id":"evt-sig","data":{"text":"簽章 private-body-marker"}}');
  test('1. correct signature over raw body → forwarded, no warning', async () => {
    const { response, calls, log, warnings } = await invoke({ body, bindings: secret, headers: { 'X-Notion-Signature': sign(body) } });
    assert.equal(response.status, 202);
    assert.equal(calls.length, 1);
    assert.deepEqual(Buffer.from(calls[0].body), body);
    assert.equal(log.signature, 'valid');
    assert.equal(warnings.length, 0);
  });
  for (const [name, headers] of [
    ['missing header', {}],
    ['wrong key', { 'X-Notion-Signature': sign(body, 'other-token') }],
    ['tampered body', { 'X-Notion-Signature': sign(Buffer.from('{"type":"comment.created"}')) }],
    ['no sha256= prefix', { 'X-Notion-Signature': sign(body).slice(7) }],
  ]) {
    test(`2. ${name} → 401, not forwarded`, async () => {
      const { response, calls, log } = await invoke({ body, bindings: secret, headers });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { ok: false, reason: 'invalid_signature' });
      assert.equal(calls.length, 0);
      assert.equal(log.signature, 'invalid');
    });
  }
  test('3. verification_token request (no signature) → forwarded even with secret set', async () => {
    const v = Buffer.from('{"verification_token":"secret_from_notion"}');
    const { response, calls, log, warnings } = await invoke({ body: v, bindings: secret });
    assert.equal(response.status, 202);
    assert.equal(calls.length, 1);
    assert.deepEqual(Buffer.from(calls[0].body), v);
    assert.equal(log.event_type, 'notion.verification');
    assert.equal(warnings.length, 0);
  });
  test('4. secret not set → one warning log, forwarded even without/with bad signature', async () => {
    for (const headers of [{}, { 'X-Notion-Signature': `sha256=${'0'.repeat(64)}` }]) {
      const { response, calls, log, warnings } = await invoke({ body, headers });
      assert.equal(response.status, 202);
      assert.equal(calls.length, 1);
      assert.deepEqual(Buffer.from(calls[0].body), body);
      assert.equal(log.signature, 'skipped_no_token');
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].level, 'warn');
      assert.equal(warnings[0].reason, 'verification_token_not_set');
    }
  });
});
test('verification bypasses signature and forwards bytes/status', async () => {
  const body = Buffer.from(' { "verification_token": "verification-secret-marker" }\n');
  const { response, calls, log } = await invoke({ body, bindings: { NOTION_WEBHOOK_VERIFICATION_TOKEN: 'already-set' }, upstreamStatus: 401 });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('X-Relay-Upstream-Status'), '401');
  assert.deepEqual(Buffer.from(calls[0].body), body);
  assert.equal(calls[0].headers['X-Relay-Event-Type'], 'notion.verification');
  assert.equal(log.signature, 'not_applicable');
  assert.equal('latency_ms' in log, false);
});
test('non-status property skips Notion API', async () => {
  const e = event(); e.data.updated_properties = ['other'];
  await dropped({ body: JSON.stringify(e) }, 'status_not_changed');
});
test('empty handoff list disables forwarding', async () => {
  await dropped({ bindings: { HANDOFF_STATUSES: '' } }, 'no_handoff_statuses_configured');
  await dropped({ bindings: { HANDOFF_STATUSES: ' , , ' } }, 'no_handoff_statuses_configured');
});
test('missing Notion token logs error without fetch', async () => {
  const { log } = await dropped({ bindings: { NOTION_API_TOKEN: undefined } }, 'missing_notion_api_token');
  assert.equal(log.action, 'error');
});
for (const parent of [
  { type: 'database_id', database_id: 'another-database' },
  { type: 'data_source_id', data_source_id: 'another-data-source' },
  { type: 'page_id', page_id: DEFAULTS.TASKS_DATABASE_ID },
  { type: 'workspace', workspace: true },
]) {
  test(`Tasks whitelist rejects ${parent.type}`, async () => {
    const p = page(); p.parent = parent;
    await dropped({ notionPage: p }, 'not_tasks_database', 200, 1);
  });
}
test('non-handoff status records current status', async () => {
  const p = page(); p.properties.Status.status.name = 'Done';
  const { log } = await dropped({ notionPage: p }, 'status_not_handoff', 200, 1);
  assert.equal(log.new_status, 'Done');
});
for (const status of [404, 403, 429, 500, 503]) {
  test(`Notion ${status} response policy`, async () => {
    const retryable = status === 429 || status >= 500;
    const { log } = await dropped({ notionStatus: status }, retryable ? 'notion_fetch_retryable' : 'notion_fetch_failed', retryable ? 503 : 200, 1);
    assert.equal(log.notion_api_status, status);
    assert.equal(log.action, 'error');
  });
}
test('all self bots skip API; mixed human authors continue', async () => {
  const e = event(); e.authors = [{ type: 'bot', id: DEFAULTS.SELF_BOT_IDS }, { type: 'bot', id: DEFAULTS.SELF_BOT_IDS }];
  await dropped({ body: JSON.stringify(e) }, 'self_triggered');
  e.authors.push({ type: 'person', id: 'human' });
  const { calls } = await invoke({ body: JSON.stringify(e) });
  assert.equal(calls.length, 2);
});
for (const authors of [[], [{ type: 'bot', id: 'other-bot' }], [{ type: 'agent', id: DEFAULTS.SELF_BOT_IDS }]]) {
  test(`non-self authors proceed: ${JSON.stringify(authors)}`, async () => {
    const e = event(); e.authors = authors;
    assert.equal((await invoke({ body: JSON.stringify(e) })).calls.length, 2);
  });
}
test('default and undefined handoff setting produce complete payload', async () => {
  for (const bindings of [{}, { HANDOFF_STATUSES: undefined }]) {
    const e = event(); const body = JSON.stringify(e);
    const { response, calls, log } = await invoke({ body, bindings: { ...bindings, NOTION_WEBHOOK_VERIFICATION_TOKEN: 'verification-secret-marker' },
      headers: { 'X-Notion-Signature': sign(body) } });
    assert.equal(response.status, 202);
    assert.equal(log.signature, 'valid');
    assert.equal(calls[0].url, 'https://api.notion.com/v1/pages/page-1');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers.Authorization, 'Bearer notion-secret-marker');
    assert.equal(calls[0].headers['Notion-Version'], DEFAULTS.NOTION_API_VERSION);
    assert.equal(calls[1].url, env.GROK_BOT_WEBHOOK_URL);
    assert.equal(calls[1].headers['X-Notion-Signature'], undefined);
    assert.deepEqual(JSON.parse(calls[1].body), {
      event_type: 'page.status_handoff', source: 'notion-webhook-relay', notion_event_id: e.id,
      notion_event_type: e.type, page_id: e.entity.id, title: '測試 task', status: 'Ready for AI',
      url: page().url, notion_event_timestamp: e.timestamp, worker_received_at: log.worker_received_at,
      authors: e.authors, attempt_number: 1,
    });
    assert.ok(Number.isFinite(Date.parse(log.worker_received_at)));
  }
});
test('multiple handoff names match case and whitespace', async () => {
  for (const status of [' ready FOR ai ', ' REVIEW ']) {
    const p = page(); p.properties.Status.status.name = status;
    const { calls } = await invoke({ notionPage: p, bindings: { HANDOFF_STATUSES: ' , Ready for AI, review, ' } });
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1].body).status, status);
  }
});
for (const type of ['database_id', 'data_source_id']) {
  test(`Tasks ${type} normalized identifier`, async () => {
    const p = page();
    p.parent = { type, [type]: DEFAULTS[type === 'database_id' ? 'TASKS_DATABASE_ID' : 'TASKS_DATA_SOURCE_ID'].replaceAll('-', '').toUpperCase() };
    assert.equal((await invoke({ notionPage: p })).calls.length, 2);
  });
}
for (const updated of [undefined, null, 'not-array']) {
  test(`missing/non-array updated_properties reads page: ${updated}`, async () => {
    const e = event(); e.data.updated_properties = updated;
    assert.equal((await invoke({ body: JSON.stringify(e) })).calls.length, 2);
  });
}
test('decoded property IDs and select fallback work', async () => {
  const e = event(); e.data.updated_properties = [decodeURIComponent(DEFAULTS.STATUS_PROPERTY_ID)];
  const p = page(); delete p.properties.Status;
  p.properties.Renamed = { id: decodeURIComponent(DEFAULTS.STATUS_PROPERTY_ID), type: 'select', select: { name: 'Ready for AI' } };
  assert.equal((await invoke({ body: JSON.stringify(e), notionPage: p })).calls.length, 2);
});
test('status uses second routine URL and auth; comments retain original routine', async () => {
  const bindings = { GROK_BOT_STATUS_WEBHOOK_URL: 'https://routine.example/status', GROK_BOT_STATUS_WEBHOOK_AUTH: 'Bearer second-secret-marker' };
  const status = await invoke({ bindings });
  assert.equal(status.calls[1].url, bindings.GROK_BOT_STATUS_WEBHOOK_URL);
  assert.equal(status.calls[1].headers.Authorization, bindings.GROK_BOT_STATUS_WEBHOOK_AUTH);
  const comment = await invoke({ bindings, body: '{"type":"comment.created"}' });
  assert.equal(comment.calls[0].url, env.GROK_BOT_WEBHOOK_URL);
  assert.equal(comment.calls[0].headers.Authorization, 'Bearer routine-secret-marker');
});
test('second routine URL alone falls back to original auth', async () => {
  const { calls } = await invoke({ bindings: { GROK_BOT_STATUS_WEBHOOK_URL: 'https://routine.example/status' } });
  assert.equal(calls[1].url, 'https://routine.example/status');
  assert.equal(calls[1].headers.Authorization, 'Bearer routine-secret-marker');
});
test('network errors have controlled responses and do not leak details', async () => {
  await dropped({ fail: 'notion' }, 'notion_fetch_retryable', 503, 1);
  const { response, log } = await invoke({ body: '{"type":"comment.created"}', fail: 'all' });
  assert.equal(response.status, 502);
  assert.equal(log.reason, 'upstream_fetch_failed');
  assert.equal((await response.text()).includes('secret-marker'), false);
});
test('health, method rejection and no-content upstream remain valid', async () => {
  assert.equal((await invoke({ method: 'GET' })).response.status, 200);
  assert.equal((await invoke({ method: 'PUT' })).response.status, 405);
  const { response } = await invoke({ body: '{"type":"comment.created"}', upstreamStatus: 204 });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
});
test('opaque non-UTF8 body remains byte-identical', async () => {
  const body = Buffer.from([0xff, 0x00, 0xfe, 0x80]);
  const { calls } = await invoke({ body });
  assert.deepEqual(Buffer.from(calls[0].body), body);
});


describe('comment events: context + self-trigger', () => {
  const GROK = DEFAULTS.SELF_BOT_IDS;
  const HUMAN = '00000000-0000-4000-8000-0000000000d1';
  const PAGE = '00000000-0000-4000-8000-0000000000d2';
  const COMMENT = '00000000-0000-4000-8000-0000000000d3';
  // Shape of a real Notion comment.created delivery: integration_id / accessible_by name the
  // subscription's bot, but the writer is only in `authors`.
  const commentEvent = (authors = [{ id: HUMAN, type: 'person' }], extra = {}) => ({
    id: 'evt-c1', type: 'comment.created', timestamp: '2026-10-09T14:18:30Z', workspace_id: 'ws',
    subscription_id: 'sub', integration_id: 'integration-1', attempt_number: 1, authors,
    accessible_by: [{ id: HUMAN, type: 'person' }, { id: GROK, type: 'bot' }],
    entity: { id: COMMENT, type: 'comment' },
    data: { page_id: PAGE, parent: { id: PAGE, type: 'page' } }, ...extra,
  });
  const longText = '收到沒'.repeat(40);
  const notion = (overrides = {}) => (url) => {
    if (url.includes('/v1/comments/')) return overrides.comment ?? { body: {
      object: 'comment', id: COMMENT, parent: { type: 'page_id', page_id: PAGE },
      created_by: { object: 'user', id: HUMAN }, rich_text: [{ plain_text: longText }] } };
    if (url.includes('/v1/pages/')) return overrides.page ?? { body: { properties: {
      Task: { type: 'title', title: [{ plain_text: '市長候選人沈伯洋提青年 AI 額度方案' }] } } } };
    throw new Error('unexpected ' + url);
  };

  test('Human comment is NOT self-trigger even though accessible_by/integration list Grok Bot', async () => {
    const { response, calls, log } = await invoke({ body: JSON.stringify(commentEvent()), notion: notion(),
      headers: { 'X-Notion-Signature': 'sha256=' + 'a'.repeat(64) } });
    assert.equal(response.status, 202);
    assert.equal(log.action, 'forwarded');
    assert.equal(log.page_id, PAGE);
    assert.equal(log.comment_id, COMMENT);
    assert.equal(log.page_title, '市長候選人沈伯洋提青年 AI 額度方案');
    assert.equal([...log.comment_preview].length, 81); // 80 chars + ellipsis
    assert.deepEqual(log.authors, [`person:${HUMAN}`]);
    assert.equal(log.notion_lookup, 'ok');
    const upstream = calls.at(-1);
    assert.equal(upstream.url, env.GROK_BOT_WEBHOOK_URL);
    assert.equal(upstream.headers['X-Notion-Signature'], undefined);
    const body = JSON.parse(upstream.body);
    assert.equal(body.type, 'comment.created');
    assert.deepEqual(body.authors, [{ id: HUMAN, type: 'person' }]);
    assert.equal(body.relay.page_id, PAGE);
    assert.equal(body.relay.comment_id, COMMENT);
    assert.equal(body.relay.page_title, '市長候選人沈伯洋提青年 AI 額度方案');
    assert.equal(body.relay.comment_preview, log.comment_preview);
    assert.ok(body.relay.comment_preview.startsWith('收到沒收到沒'));
  });

  test('Grok Bot own comment is dropped at the Worker without Notion calls', async () => {
    const { response, calls, log } = await invoke({
      body: JSON.stringify(commentEvent([{ id: GROK, type: 'bot' }])), notion: notion() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, forwarded: false, reason: 'self_triggered' });
    assert.equal(calls.length, 0);
    assert.equal(log.action, 'dropped');
    assert.equal(log.reason, 'self_triggered');
    assert.equal(log.page_id, PAGE);
    assert.equal(log.comment_id, COMMENT);
  });

  test('configurable SELF_BOT_IDS list (dashed or not) drops other own bots', async () => {
    const other = '00000000-0000-4000-8000-0000000000d4';
    const { calls, log } = await invoke({ body: JSON.stringify(commentEvent([{ id: other.replaceAll('-', ''), type: 'bot' }])),
      bindings: { SELF_BOT_IDS: `${GROK}, ${other}` }, notion: notion() });
    assert.equal(calls.length, 0);
    assert.equal(log.reason, 'self_triggered');
  });

  test('unknown bot or mixed authors are forwarded', async () => {
    for (const authors of [[{ id: 'other-bot', type: 'bot' }], [{ id: GROK, type: 'bot' }, { id: HUMAN, type: 'person' }]]) {
      const { log } = await invoke({ body: JSON.stringify(commentEvent(authors)), notion: notion() });
      assert.equal(log.action, 'forwarded');
    }
  });

  test('missing authors falls back to comment created_by for self-trigger', async () => {
    const { calls, log } = await invoke({ body: JSON.stringify(commentEvent([])), notion: notion({ comment: { body: {
      id: COMMENT, created_by: { id: GROK }, rich_text: [{ plain_text: '收到了！' }] } } }) });
    assert.equal(log.reason, 'self_triggered');
    assert.equal(calls.length, 1); // only the comment lookup, never the routine
  });

  test('Notion lookup failures still forward with ids and record the error', async () => {
    const { log, calls } = await invoke({ body: JSON.stringify(commentEvent()),
      notion: notion({ comment: { status: 404, body: {} }, page: new Error('network secret-marker') }) });
    assert.equal(log.action, 'forwarded');
    assert.equal(log.notion_lookup, 'comment_404,page_fetch_failed');
    const body = JSON.parse(calls.at(-1).body);
    assert.equal(body.relay.page_id, PAGE);
    assert.equal(body.relay.comment_preview, null);
  });

  test('no NOTION_API_TOKEN: forwards ids without lookups', async () => {
    const { calls, log } = await invoke({ body: JSON.stringify(commentEvent()), bindings: { NOTION_API_TOKEN: undefined }, notion: notion() });
    assert.equal(calls.length, 1);
    assert.equal(log.notion_lookup, 'skipped_no_token');
    assert.equal(JSON.parse(calls[0].body).relay.comment_id, COMMENT);
  });

  test('status handoff log includes page title', async () => {
    const { log } = await invoke();
    assert.equal(log.page_title, '測試 task');
    assert.equal(log.page_id, 'page-1');
    assert.equal(log.comment_id, null);
  });
});

});

