import { list, normalizeId } from './config.js';
import { fetchComment, fetchPage, pageTitle } from './notion.js';

export const PREVIEW_LENGTH = 80;

/** Collapse whitespace and keep the first `length` code points (not UTF-16 units). */
export function preview(text, length = PREVIEW_LENGTH) {
  const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()];
  return chars.length > length ? `${chars.slice(0, length).join('')}…` : chars.join('');
}
export const richText = (parts) => (Array.isArray(parts) ? parts : []).map((p) => p?.plain_text ?? p?.text?.content ?? '').join('');

/** True when every author is a bot listed in SELF_BOT_IDS (people or unknown bots keep the event). */
export function selfTriggered(authors, env) {
  const bots = list(env.SELF_BOT_IDS).map(normalizeId);
  return Array.isArray(authors) && authors.length > 0 &&
    authors.every((a) => a?.type === 'bot' && bots.includes(normalizeId(a.id)));
}

/**
 * Notion comment events carry ids only: entity = the comment, data.page_id = the page,
 * data.parent = page or block. `integration_id` / `accessible_by` describe the subscription,
 * NOT who wrote the comment; the writer is in `authors`.
 */
export async function commentContext(event, env, log) {
  const commentId = event.entity?.type === 'comment' || !event.entity?.type ? event.entity?.id ?? null : null;
  const parent = event.data?.parent ?? {};
  const pageId = event.data?.page_id ?? (parent.type === 'page' ? parent.id : null) ?? null;
  const authors = Array.isArray(event.authors) ? event.authors : [];
  const context = {
    page_id: pageId, page_title: null, comment_id: commentId, comment_preview: null,
    comment_author_ids: authors.map((a) => a?.id).filter(Boolean),
    comment_author_types: authors.map((a) => a?.type ?? 'unknown'),
  };
  Object.assign(log, context);
  if (selfTriggered(authors, env)) return { context, reason: 'self_triggered' };
  if (!env.NOTION_API_TOKEN) { log.notion_lookup = 'skipped_no_token'; return { context }; }
  const errors = [];
  if (commentId && event.type !== 'comment.deleted') {
    try {
      const response = await fetchComment(commentId, env);
      if (response.ok) {
        const comment = await response.json();
        context.comment_preview = preview(richText(comment.rich_text));
        const createdBy = comment.created_by?.id;
        // Fallback self-trigger check when the webhook omitted authors.
        if (!authors.length && createdBy) {
          context.comment_author_ids = [createdBy];
          if (list(env.SELF_BOT_IDS).map(normalizeId).includes(normalizeId(createdBy))) {
            Object.assign(log, context);
            return { context, reason: 'self_triggered' };
          }
        }
        if (!context.page_id && comment.parent?.type === 'page_id') context.page_id = comment.parent.page_id;
      } else errors.push(`comment_${response.status}`);
    } catch { errors.push('comment_fetch_failed'); }
  }
  if (context.page_id) {
    try {
      const response = await fetchPage(context.page_id, env);
      if (response.ok) context.page_title = pageTitle(await response.json());
      else errors.push(`page_${response.status}`);
    } catch { errors.push('page_fetch_failed'); }
  }
  log.notion_lookup = errors.length ? errors.join(',') : 'ok';
  Object.assign(log, context);
  return { context };
}
