# notion-webhook-relay

A zero-dependency Cloudflare Worker that receives [Notion webhooks](https://developers.notion.com/reference/webhooks), verifies their HMAC signature, filters/enriches events, and forwards them to an upstream webhook (e.g. a Grok Bot routine) with an `Authorization: Bearer` header.

## What it does

- **HMAC verification** of `X-Notion-Signature` over the raw request body.
- **Event routing**
  - `page.properties_updated` → *status handoff*: forwards a compact `page.status_handoff` payload only when a page in your Tasks database moves into one of `HANDOFF_STATUSES` (default `Ready for AI`).
  - `comment.created` / `comment.updated` → drops comments written by your own bot(s) (`SELF_BOT_IDS`), otherwise forwards the original event plus a `relay` block (`page_id`, `page_title`, `comment_id`, `comment_preview`, author ids/types).
  - Notion's one-time `{"verification_token": "..."}` request and unknown events are forwarded byte-for-byte.
- Structured one-line JSON logs (no tokens, auth headers or bodies are logged).

## HMAC signature verification

Notion signs the **raw body** with HMAC-SHA256 keyed by the subscription's `verification_token` and sends `X-Notion-Signature: sha256=<hex>`. The Worker reads raw bytes before JSON parsing and verifies with `crypto.subtle.verify` (constant-time, no manual digest comparison).

| Case | Behaviour |
| --- | --- |
| Secret set, valid signature | Forward |
| Secret set, invalid / missing / malformed signature | `401 {"ok":false,"reason":"invalid_signature"}`, not forwarded |
| Body is the verification request | Not verified, forwarded so the routine receives the token |
| Secret not set | Logs a `notion_webhook_warning` and forwards (set it in production!) |

## Event routing details

Status handoff pipeline: verify → drop if all authors are in `SELF_BOT_IDS` → drop if Status was not among `updated_properties` → fetch page via Notion API → require parent `database_id`/`data_source_id` to match `TASKS_DATABASE_ID`/`TASKS_DATA_SOURCE_ID` → require current Status in `HANDOFF_STATUSES` → forward.

Filtered events return `200 {"ok":true,"forwarded":false,"reason":"..."}` so Notion does not retry (`self_triggered`, `status_not_changed`, `no_handoff_statuses_configured`, `missing_notion_api_token`, `not_tasks_database`, `status_not_handoff`). Retryable Notion API errors (429/5xx, network) return 503. Upstream status is passed through; upstream network failure returns 502.

Forwarded requests carry `X-Relay-Event-Type`, `X-Relay-Received-At`, `X-Relay-Notion-Event-Timestamp` (when present). Rebuilt bodies (handoff, comments) do not carry the original `X-Notion-Signature`.

## Configuration

All configuration comes from environment bindings. Nothing workspace-specific is committed.

**Secrets** (`wrangler secret put <NAME>`):

| Name | Purpose |
| --- | --- |
| `GROK_BOT_WEBHOOK_URL` | Upstream webhook URL (required) |
| `GROK_BOT_WEBHOOK_AUTH` | Upstream key, raw or `Bearer ...` (required) |
| `NOTION_WEBHOOK_VERIFICATION_TOKEN` | Notion subscription verification token (strongly recommended) |
| `NOTION_API_TOKEN` | Notion integration token, used to read pages/comments |
| `GROK_BOT_STATUS_WEBHOOK_URL` / `_AUTH` | Optional separate upstream for status handoffs |

**Vars** (`[vars]` in `wrangler.toml`, or secrets if you prefer to keep IDs private):

| Name | Default |
| --- | --- |
| `TASKS_DATABASE_ID`, `TASKS_DATA_SOURCE_ID` | *(none — required for handoff)* |
| `SELF_BOT_IDS` | *(none)* comma-separated bot user ids to ignore |
| `STATUS_PROPERTY_NAME` | `Status` |
| `STATUS_PROPERTY_ID` | `notion%3A%2F%2Ftasks%2Fstatus_property` |
| `HANDOFF_STATUSES` | `Ready for AI` (comma list; empty string disables) |
| `NOTION_API_VERSION` | `2022-06-28` |

For local development copy `.dev.vars.example` to `.dev.vars` (git-ignored).

## Deploy

```bash
npm install
npx wrangler login            # or export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put GROK_BOT_WEBHOOK_URL
npx wrangler secret put GROK_BOT_WEBHOOK_AUTH
npx wrangler secret put NOTION_API_TOKEN
npx wrangler secret put TASKS_DATABASE_ID     # or put IDs in [vars]
npx wrangler secret put TASKS_DATA_SOURCE_ID
npx wrangler secret put SELF_BOT_IDS
npx wrangler deploy
```

Then in Notion (integration → Webhooks):

1. Set the URL to your `https://notion-webhook-relay.<subdomain>.workers.dev`.
2. Subscribe to `comment.created`, `comment.updated`, `page.properties_updated`; enable the *Read comments* capability.
3. The verification request is forwarded to your upstream; take the token and run `npx wrangler secret put NOTION_WEBHOOK_VERIFICATION_TOKEN` (pipe it from an env var to keep it out of shell history).
4. Share your Tasks database with the integration and make sure the handoff status exists.

Logs: `npx wrangler tail notion-webhook-relay --format json`, filter `msg = notion_webhook`.

## Development

Requires Node 20+. Tests use the built-in `node:test` runner with all `fetch` calls mocked (no network).

```bash
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
