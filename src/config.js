// Workspace-specific IDs have no defaults: set them via wrangler vars or .dev.vars.
export const DEFAULTS = {
  TASKS_DATABASE_ID: '',
  TASKS_DATA_SOURCE_ID: '',
  STATUS_PROPERTY_NAME: 'Status',
  STATUS_PROPERTY_ID: 'notion%3A%2F%2Ftasks%2Fstatus_property',
  SELF_BOT_IDS: '',
  NOTION_API_VERSION: '2022-06-28',
  HANDOFF_STATUSES: 'Ready for AI',
};
export const normalizeId = (id) => String(id ?? '').replaceAll('-', '').toLowerCase();
export const normalizeStatus = (name) => String(name ?? '').trim().toLowerCase();
export const list = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export function decodeProperty(id) {
  try { return decodeURIComponent(id); } catch { return id; }
}
/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {typeof DEFAULTS & Record<string, string>}
 */
export function config(env = {}) {
  // Undefined bindings use defaults; an explicit empty string remains disabled.
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) };
}
export function buildAuthHeader(secret) {
  const value = secret.trim();
  return /^bearer\s+/i.test(value) ? value : `Bearer ${value}`;
}
