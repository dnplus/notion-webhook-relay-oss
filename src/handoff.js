import { decodeProperty, list, normalizeId, normalizeStatus } from './config.js';
import { fetchPage, isTasks, pageStatus, pageTitle } from './notion.js';
export async function handoff(event, env, log) {
  const bots = list(env.SELF_BOT_IDS).map(normalizeId);
  if (Array.isArray(event.authors) && event.authors.length && event.authors.every(
    (a) => a.type === 'bot' && bots.includes(normalizeId(a.id)))) return { reason: 'self_triggered' };
  if (Array.isArray(event.data?.updated_properties) && !event.data.updated_properties.some(
    (id) => decodeProperty(id) === decodeProperty(env.STATUS_PROPERTY_ID))) return { reason: 'status_not_changed' };
  const statuses = list(env.HANDOFF_STATUSES).map(normalizeStatus);
  if (!statuses.length) return { reason: 'no_handoff_statuses_configured' };
  if (!env.NOTION_API_TOKEN) return { reason: 'missing_notion_api_token', action: 'error' };
  let response;
  try { response = await fetchPage(event.entity?.id ?? '', env); }
  catch { return { reason: 'notion_fetch_retryable', status: 503, action: 'error' }; }
  if (!response.ok) {
    log.notion_api_status = response.status;
    const retry = response.status === 429 || response.status >= 500;
    return { reason: retry ? 'notion_fetch_retryable' : 'notion_fetch_failed', status: retry ? 503 : 200, action: 'error' };
  }
  let page;
  try { page = await response.json(); }
  catch { return { reason: 'notion_fetch_failed', action: 'error' }; }
  if (!isTasks(page, env)) return { reason: 'not_tasks_database' };
  log.page_title = pageTitle(page);
  const status = pageStatus(page, env);
  log.new_status = status;
  if (!statuses.includes(normalizeStatus(status))) return { reason: 'status_not_handoff' };
  return { payload: {
    event_type: 'page.status_handoff', source: 'notion-webhook-relay', notion_event_id: event.id,
    notion_event_type: event.type, page_id: event.entity?.id, title: pageTitle(page), status,
    url: page.url, notion_event_timestamp: event.timestamp, worker_received_at: log.worker_received_at,
    authors: event.authors ?? [], attempt_number: event.attempt_number,
  } };
}
