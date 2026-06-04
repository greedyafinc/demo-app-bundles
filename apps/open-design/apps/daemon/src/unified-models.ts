// UnifiedAI model catalog reader.
//
// Lists models from the unified-api gateway through the SDK (`client.models
// .list`) and maps the rows onto the daemon's `RuntimeModelOption` shape so the
// existing model picker (and chat model validation) is sourced from the
// platform catalog instead of any locally-installed CLI. Only reached when the
// broker is configured (see runtimes/detection.ts), so the SDK's broker token
// is available; the models endpoint itself is auth-optional.

import type { Model } from '@unifiedai/sdk/browser';
import type { RuntimeModelOption } from './runtimes/types.js';
import { getUnifiedClient } from './unified-client.js';

/**
 * Provider/author name for a catalog row, preferring the human-friendly
 * `model_author.name` (present when the request asks for `include: ['author']`)
 * and falling back to the bare `owned_by` slug. Used by the web picker to
 * resolve the model's brand logo; `undefined` when neither is a string.
 */
function rowAuthor(row: Model): string | undefined {
  const authorName = row.model_author?.name;
  if (typeof authorName === 'string' && authorName) return authorName;
  if (typeof row.owned_by === 'string' && row.owned_by) return row.owned_by;
  return undefined;
}

// Cache the catalog briefly so a burst of /api/agents calls (boot, settings
// open, model-menu open) doesn't re-hit the gateway each time.
const CATALOG_TTL_MS = 30_000;
let catalogCache: { at: number; models: RuntimeModelOption[] } | null = null;

/**
 * Text-capable models from the platform catalog (plus the synthetic `auto`
 * router), shaped for the agent model picker. Media types (image/video/audio/
 * embedding) are filtered out — those drive the media surfaces, not chat.
 */
export async function fetchUnifiedTextModels(): Promise<RuntimeModelOption[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models;
  }

  // Invalidate any stale entry up front so a fetch failure surfaces the error
  // (and re-fetches next call) instead of being masked by a cached list for the
  // rest of the TTL window. The cache is only re-populated on a clean success.
  catalogCache = null;

  // `include: ['author']` expands each row with a `model_author` object (name +
  // brand color); without it the catalog only carries the bare `owned_by` slug.
  // We want the friendly name for logo resolution on the web. The SDK throws a
  // typed error on a non-2xx response, which the caller (detection.ts) catches
  // and falls back from.
  const { data: rows } = await getUnifiedClient().models.list({ include: ['author'] });

  const models: RuntimeModelOption[] = [];
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue;
    const id = row.id;
    const type = typeof row.type === 'string' ? row.type : 'text';
    // Keep the `auto` router and every text model; drop media/embedding rows.
    if (id !== 'auto' && type !== 'text') continue;
    const name = typeof row.name === 'string' && row.name ? row.name : id;
    const option: RuntimeModelOption = { id, label: name };
    // Only attach `author` when present — `exactOptionalPropertyTypes` forbids
    // assigning an explicit `undefined` to the optional field.
    const author = rowAuthor(row);
    if (author) option.author = author;
    models.push(option);
  }

  catalogCache = { at: now, models };
  return models;
}
