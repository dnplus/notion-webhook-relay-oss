import { buildAuthHeader, config } from './config.js';
import { verifySignature } from './signature.js';
import { createLog } from './log.js';
import { handoff } from './handoff.js';
import { commentContext } from './comment.js';

export default {
  async fetch(request, environment) {
    const received = new Date().toISOString();
    let log = createLog(received);
    try {
      if (request.method === 'GET') {
        Object.assign(log, { action: 'dropped', reason: 'health_check' });
        return Response.json({ ok: true, service: 'notion-webhook-relay' });
      }
      if (request.method !== 'POST') {
        Object.assign(log, { action: 'rejected', reason: 'method_not_allowed' });
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
      }
      const env = config(environment);
      // Raw body bytes: HMAC is computed over exactly what Notion signed, before any JSON parsing.
      const bytes = await request.arrayBuffer();
      let event = {};
      try { event = JSON.parse(new TextDecoder().decode(bytes)) ?? {}; } catch { /* Preserve opaque bodies. */ }
      log = createLog(received, event);
      const verification = typeof event.verification_token === 'string' && !event.type && Object.keys(event).length === 1;
      if (verification) log.event_type = 'notion.verification';
      if (!verification) {
        log.signature = env.NOTION_WEBHOOK_VERIFICATION_TOKEN
          ? (await verifySignature(bytes, env.NOTION_WEBHOOK_VERIFICATION_TOKEN, request.headers.get('X-Notion-Signature')) ? 'valid' : 'invalid')
          : 'skipped_no_token';
        if (log.signature === 'skipped_no_token') {
          console.log(JSON.stringify({
            msg: 'notion_webhook_warning', level: 'warn', reason: 'verification_token_not_set',
            detail: 'NOTION_WEBHOOK_VERIFICATION_TOKEN is not set; X-Notion-Signature not verified, forwarding anyway',
          }));
        }
        if (log.signature === 'invalid') {
          Object.assign(log, { action: 'rejected', reason: 'invalid_signature' });
          return Response.json({ ok: false, reason: log.reason }, { status: 401 });
        }
      }
      let body = bytes;
      const statusEvent = event.type === 'page.properties_updated';
      if (statusEvent) {
        const result = await handoff(event, env, log);
        if (!result.payload) {
          Object.assign(log, { action: result.action ?? 'dropped', reason: result.reason });
          return Response.json({ ok: true, forwarded: false, reason: result.reason }, { status: result.status ?? 200 });
        }
        body = JSON.stringify(result.payload);
      }
      // Comment events: drop our own bot's comments, then forward the original event plus a
      // `relay` block (page_id, page_title, comment_id, comment_preview). The body is rebuilt,
      // so the original X-Notion-Signature no longer applies and is not forwarded.
      const commentEvent = typeof event.type === 'string' && event.type.startsWith('comment.');
      if (commentEvent) {
        const result = await commentContext(event, env, log);
        if (result.reason) {
          Object.assign(log, { action: 'dropped', reason: result.reason });
          return Response.json({ ok: true, forwarded: false, reason: result.reason });
        }
        body = JSON.stringify({ ...event, relay: { source: 'notion-webhook-relay', ...result.context } });
      }
      const webhookUrl = (statusEvent && env.GROK_BOT_STATUS_WEBHOOK_URL) || env.GROK_BOT_WEBHOOK_URL;
      const auth = (statusEvent && env.GROK_BOT_STATUS_WEBHOOK_AUTH) || env.GROK_BOT_WEBHOOK_AUTH;
      if (!webhookUrl || !auth) {
        log.reason = 'missing_webhook_config';
        return Response.json({ ok: false, error: 'Worker webhook secrets not configured' }, { status: 500 });
      }
      const headers = {
        Authorization: buildAuthHeader(auth), 'Content-Type': 'application/json',
        'X-Relay-Event-Type': log.event_type, 'X-Relay-Received-At': received,
      };
      if (event.timestamp) headers['X-Relay-Notion-Event-Timestamp'] = event.timestamp;
      const signature = request.headers.get('X-Notion-Signature');
      if (!statusEvent && !commentEvent && signature) headers['X-Notion-Signature'] = signature;
      let upstream;
      let responseBody;
      try {
        upstream = await fetch(webhookUrl, { method: 'POST', headers, body });
        responseBody = await upstream.arrayBuffer();
      } catch {
        log.reason = 'upstream_fetch_failed';
        return Response.json({ ok: false, error: 'Failed to reach Grok Bot webhook' }, { status: 502 });
      }
      Object.assign(log, { action: 'forwarded', reason: 'forwarded', upstream_status: upstream.status });
      return new Response([204, 205, 304].includes(upstream.status) ? null : responseBody, {
        status: upstream.status, headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'X-Relay-Upstream-Status': String(upstream.status),
        },
      });
    } catch {
      Object.assign(log, { action: 'error', reason: 'internal_error' });
      return Response.json({ ok: false, reason: log.reason }, { status: 500 });
    } finally { console.log(JSON.stringify(log)); }
  },
};
