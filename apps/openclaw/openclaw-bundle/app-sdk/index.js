// SDK for marketplace node-service apps to authenticate to unified-api.
//
// The desktop host injects three env vars into every node-service child:
//
//   UNIFIED_BROKER_URL    e.g. http://127.0.0.1:54321
//   UNIFIED_BROKER_TOKEN  per-launch shared secret
//   UNIFIED_APP_SLUG      this bundle's slug ("opendesign", etc.)
//
// `getAppToken()` returns a short-lived JWT minted by base-api for THIS app
// (carries `sub`=user, `app`=slug, `device`=device_id) and caches it until
// shortly before expiry. `unifiedFetch()` wraps fetch() to attach the bearer.
//
// Outside the desktop host (e.g. running the daemon directly for dev), the
// env vars are absent and helpers throw a clear error.

const REFRESH_MARGIN_MS = 30 * 1000;

let cached = null;

function brokerUrl() {
  const url = process.env.UNIFIED_BROKER_URL;
  if (!url) throw new Error('UNIFIED_BROKER_URL is not set — not running inside the UnifiedApp desktop host');
  return url;
}

function brokerToken() {
  const t = process.env.UNIFIED_BROKER_TOKEN;
  if (!t) throw new Error('UNIFIED_BROKER_TOKEN is not set');
  return t;
}

function appSlug() {
  const s = process.env.UNIFIED_APP_SLUG;
  if (!s) throw new Error('UNIFIED_APP_SLUG is not set');
  return s;
}

export async function getAppToken({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && cached.expiresAt - REFRESH_MARGIN_MS > now) {
    return cached.token;
  }

  const slug = appSlug();
  const res = await fetch(`${brokerUrl()}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-broker-token': brokerToken(),
    },
    body: JSON.stringify({ app_slug: slug }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Broker token fetch failed: ${res.status} ${text}`);
  }

  const body = await res.json();
  cached = {
    token: body.token,
    expiresAt: now + body.expires_in * 1000,
  };
  return cached.token;
}

export async function unifiedFetch(path, init = {}) {
  const base = process.env.UNIFIED_API_URL || 'http://localhost:3141';
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const token = await getAppToken();
  const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    // Token may have rolled over; force-refresh and try once more.
    const fresh = await getAppToken({ force: true });
    const retryHeaders = { ...(init.headers || {}), Authorization: `Bearer ${fresh}` };
    return fetch(url, { ...init, headers: retryHeaders });
  }
  return res;
}

export function getAppSlug() {
  return appSlug();
}
