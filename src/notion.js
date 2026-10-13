import { decodeProperty, normalizeId } from './config.js';
export async function fetchPage(id, env) {
  return fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${env.NOTION_API_TOKEN}`, 'Notion-Version': env.NOTION_API_VERSION },
  });
}
export async function fetchComment(id, env) {
  return fetch(`https://api.notion.com/v1/comments/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${env.NOTION_API_TOKEN}`, 'Notion-Version': env.NOTION_API_VERSION },
  });
}
export function isTasks(page, env) {
  const parent = page.parent ?? {};
  return Boolean((parent.database_id && normalizeId(parent.database_id) === normalizeId(env.TASKS_DATABASE_ID)) ||
    (parent.data_source_id && normalizeId(parent.data_source_id) === normalizeId(env.TASKS_DATA_SOURCE_ID)));
}
export function pageStatus(page, env) {
  const properties = page.properties ?? {};
  const property = properties[env.STATUS_PROPERTY_NAME] ?? Object.values(properties).find(
    (p) => decodeProperty(p.id) === decodeProperty(env.STATUS_PROPERTY_ID));
  return property?.status?.name ?? property?.select?.name ?? '';
}
export function pageTitle(page) {
  const title = Object.values(page.properties ?? {}).find((p) => p.type === 'title');
  return (title?.title ?? []).map((part) => part.plain_text ?? '').join('');
}
