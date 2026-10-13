export function createLog(received, event = {}) {
  const log = {
    msg: 'notion_webhook', worker_received_at: received,
    event_type: event.type ?? 'unknown', notion_event_id: event.id ?? null,
    notion_event_timestamp: event.timestamp ?? null, page_id: event.data?.page_id ?? (event.entity?.type === 'comment' ? null : event.entity?.id ?? null),
    page_title: null, comment_id: event.entity?.type === 'comment' ? event.entity.id : null, comment_preview: null,
    authors: Array.isArray(event.authors) ? event.authors.map((a) => `${a?.type ?? 'unknown'}:${a?.id ?? ''}`) : [],
    signature: 'not_applicable', action: 'error', reason: null, upstream_status: null,
  };
  const timestamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
  if (Number.isFinite(timestamp)) log.latency_ms = Date.parse(received) - timestamp;
  return log;
}
