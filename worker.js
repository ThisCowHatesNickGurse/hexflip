 Hexium Flip — Cloudflare Module Worker + SQLite Durable Object.
// Deploy with the included wrangler.jsonc. Never put login cookies in source.
const HEX = 'https://hexium.zip';
const VALUES = 'https://heximons.lol/api/items/v3/itemdetails';
const enc = new TextEncoder();
const SESSION_MS = 12 * 60 * 60 * 1000;
const OPEN_MS = 15 * 60 * 1000;
const activeStates = new Set(['open', 'settling', 'reconciling', 'review']);
const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const hash = async text => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
class UpstreamError extends Error { constructor(message, uncertain = false, rejectedWrite = false) { super(message); this.uncertain = uncertain; this.rejectedWrite = rejectedWrite; } }
const must = (condition, message, status = 400) => { if (!condition) throw new AppError(message, status); };
const units = number => {
  must(typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1e12, 'Invalid item valuation.');
  return Math.round(number * 1000);
};
export function stakeMatch(a, b) { return a > 0 && b > 0 && BigInt(Math.max(a, b)) * 100n <= BigInt(Math.min(a, b)) * 101n; }
export function joinRange(a, percent = 3) {
  return {
    min: Number(BigInt(a) * 100n / (BigInt(100 + percent) * 1000n)),
    max: Number(BigInt(a) * BigInt(100 + percent) / 100000n)
  };
}
export function roundedStakeMatch(a, b) {
  if (a <= 0 || b <= 0) return false;
  const range = joinRange(a);
  return b >= range.min * 1000 && b <= range.max * 1000;
}

export function effectiveValue(item, values) {
  const row = values?.assets?.[String(item.assetId)];
  const value = Array.isArray(row) && typeof row[3] === 'number' && row[3] > 0 ? row[3] : null;
  const rap = Array.isArray(row) && typeof row[2] === 'number' && row[2] >= 0 ? row[2] : item.recentAveragePrice;
  const amount = value ?? rap;
  return { amount, units: units(amount), source: value === null ? 'RAP' : 'Heximons' };
}
export function exactTrade(trade, payout) {
  if (!Array.isArray(trade?.offers) || trade.offers.length !== 2) return false;
  const expected = new Map([[payout.loserId, payout.stakeIds], [payout.winnerId, [payout.returnId]]]);
  const seen = new Set();
  for (const offer of trade.offers) {
    const id = Number(offer.user?.id);
    if (!expected.has(id) || seen.has(id) || (offer.robux != null && offer.robux !== 0)) return false;
    seen.add(id);
    const got = (offer.userAssets || []).map(x => Number(x.id)).sort((a, b) => a - b);
    const want = [...expected.get(id)].sort((a, b) => a - b);
    if (got.length !== want.length || got.some((x, i) => x !== want[i])) return false;
  }
  return seen.size === 2;
}
export function proofMessage(g) {
  return JSON.stringify([g.matchingRule === 'floor-range-3pct-v1' ? 'hexium-flip-v3-floor-range-3pct' : g.matchingRule === 'floor-range-v1' ? 'hexium-flip-v2-floor-range' : 'hexium-flip-v1', g.id, g.nonce, g.a.id, g.b.id,
    g.clientA, g.clientB, g.a.total, g.b.total,
    g.a.items.map(x => x.userAssetId), g.b.items.map(x => x.userAssetId)]);
}
export async function draw(seed, message, total) {
  const key = await crypto.subtle.importKey('raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const n = BigInt(total), space = 1n << 256n, limit = space - space % n;
  for (let counter = 0; ; counter++) {
    const digest = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message + ':' + counter))));
    const x = BigInt('0x' + digest);
    if (x < limit) return { ticket: Number(x % n), digest, counter };
  }
}
function cookieToken(request) {
  return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('__Host-flip='))?.slice(12) || '';
}
function sessionCookie(token, age = SESSION_MS / 1000) {
  return `__Host-flip=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
}
async function limitedBody(request) {
  must(Number(request.headers.get('Content-Length') || 0) <= 32768, 'Request too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0, parts = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32768) { await reader.cancel(); throw new AppError('Request too large.', 413); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AppError('Invalid JSON.'); }
}
// Public thumbnails never receive player login cookies. Only Hexium image URLs are returned.
export function safeImageUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'hexium.zip' || u.hostname.endsWith('.hexium.zip')) ? u.href : null;
  } catch { return null; }
}
const thumbnailCache = new Map();
async function thumbnails(url) {
  const getIds = (field, max) => {
    const raw = url.searchParams.get(field);
    if (!raw) return [];
    const parts = raw.split(',');
    must(parts.length <= max && parts.every(x => /^\d{1,15}$/.test(x) && Number.isSafeInteger(Number(x)) && Number(x) > 0), 'Invalid thumbnail IDs.');
    return [...new Set(parts.map(Number))];
  };
  const assets = getIds('assetIds', 50), users = getIds('userIds', 20);
  const group = async (kind, ids) => {
    const result = {}, missing = [];
    for (const id of ids) {
      const cached = thumbnailCache.get(kind + ':' + id);
      if (cached && cached.expires > Date.now()) result[id] = cached.url;
      else missing.push(id);
    }
    if (!missing.length) return result;
    const path = kind === 'assets'
      ? '/apisite/thumbnails/v1/assets?assetIds=' + missing.join(',')
      : '/apisite/thumbnails/v1/users/avatar-headshot?userIds=' + missing.join(',');
    try {
      const response = await fetch(HEX + path + '&size=150x150&format=Png&isCircular=false', {
        headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(25000)
      });
      if (!response.ok) return result;
      const data = await response.json();
      for (const entry of data.data || []) {
        const id = Number(entry.targetId), image = safeImageUrl(entry.imageUrl);
        if (missing.includes(id) && entry.state === 'Completed' && image) {
          result[id] = image; thumbnailCache.set(kind + ':' + id, { url: image, expires: Date.now() + 3600000 });
        }
      }
      if (thumbnailCache.size > 1500) {
        for (const key of [...thumbnailCache.keys()].slice(0, 500)) thumbnailCache.delete(key);
      }
    } catch {} // Thumbnails can fail independently of inventory and trade operations.
    return result;
  };
  const [assetImages, userImages] = await Promise.all([group('assets', assets), group('users', users)]);
  return { assets: assetImages, users: userImages };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https://hexium.zip https://*.hexium.zip; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    };
    try {
      if (url.pathname === '/' && request.method === 'GET') return new Response(HTML, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      if (url.pathname === '/api/thumbnails' && request.method === 'GET') return json(await thumbnails(url), 200, headers);
      if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404, headers });
      must(request.method === 'GET' || request.method === 'POST', 'Method not allowed.', 405);
      if (request.method === 'POST') {
        must(request.headers.get('Origin') === url.origin, 'Request origin rejected.', 403);
        must(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', 'Send JSON.', 415);
      }
      must(env.LOBBY && /^[a-f0-9]{64}$/i.test(env.COOKIE_KEY || ''), 'Configure LOBBY and the COOKIE_KEY secret before using the site.', 503);
      const h = new Headers(request.headers);
      h.set('X-Flip-IP', await hash(request.headers.get('CF-Connecting-IP') || 'local'));
      const result = await env.LOBBY.get(env.LOBBY.idFromName('main-v1')).fetch(new Request(request, { headers: h }));
      const outgoing = new Headers(result.headers);
      for (const [key, value] of Object.entries(headers)) outgoing.set(key, value);
      return new Response(result.body, { status: result.status, headers: outgoing });
    } catch (error) { return json({ error: error instanceof AppError ? error.message : 'Unexpected server error.' }, error.status || 500, headers); }
  }
};

export class FlipLobby {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.queue = Promise.resolve(); this.valuesCache = null;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id))');
  }
  // Serializes mutations, including upstream calls; no 30-second blockConcurrencyWhile around network I/O.
  run(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  get(kind, id) { const r = [...this.sql.exec('SELECT data FROM records WHERE kind=? AND id=?', kind, String(id))][0]; return r ? JSON.parse(r.data) : null; }
  put(kind, id, data) { this.sql.exec('INSERT OR REPLACE INTO records VALUES(?,?,?)', kind, String(id), JSON.stringify(data)); }
  del(kind, id) { this.sql.exec('DELETE FROM records WHERE kind=? AND id=?', kind, String(id)); }
  all(kind) { return [...this.sql.exec('SELECT data FROM records WHERE kind=?', kind)].map(x => JSON.parse(x.data)); }
  async key() {
    return crypto.subtle.importKey('raw', Uint8Array.from(this.env.COOKIE_KEY.match(/../g), b => parseInt(b, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async seal(cookie, userId) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(String(userId)) }, await this.key(), enc.encode(cookie)));
    return { iv: hex(iv), bytes: hex(bytes) };
  }
  async credentials(id) {
    const user = this.get('user', id);
    if (!user || user.expires < Date.now()) throw new UpstreamError('Hexium login expired. Log in again.');
    const toBytes = h => Uint8Array.from(h.match(/../g), b => parseInt(b, 16));
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBytes(user.cookie.iv), additionalData: enc.encode(String(id)) }, await this.key(), toBytes(user.cookie.bytes));
    return { user, cookie: new TextDecoder().decode(bytes) };
  }
  async raw(cookie, path, method = 'GET', body, csrf) {
    // Diagnostics exclude request headers and redact this connection's secrets.
    const redact = value => {
      let text = String(value ?? '');
      for (const secret of [cookie, csrf]) if (secret) {
        for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
          text = text.split(form).join('[REDACTED]');
        }
      }
      text = text.replace(/(\.ROBLOSECURITY\s*=\s*)[^;\s"<>]+/gi, '$1[REDACTED]');
      return text.slice(0, 3000);
    };
    const signal = AbortSignal.timeout(25000);
    const started = Date.now();
    let response;
    try {
      response = await fetch(HEX + path, {
        method,
        headers: {
          Accept: 'application/json',
          Cookie: `.ROBLOSECURITY=${cookie}`,
          'Cache-Control': 'no-store',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Manual redirects show their HTTP status without forwarding the cookie.
        redirect: 'manual',
        signal
      });
    } catch (error) {
      const diagnostic = {
        source: 'Cloudflare fetch exception; no Hexium HTTP response received',
        endpoint: HEX + path,
        elapsedMs: Date.now() - started,
        timedOut: signal.aborted,
        name: String(error?.name || 'Error'),
        message: redact(error?.message || error)
      };
      throw new UpstreamError('Hexium connection failed: ' + JSON.stringify(diagnostic), method === 'POST');
    }

    if (path === '/apisite/users/v1/users/authenticated') {
      let responseBody;
      try { responseBody = await response.clone().text(); }
      catch (error) {
        throw new UpstreamError('Hexium login response body failed: ' + JSON.stringify({
          status: response.status,
          contentType: response.headers.get('content-type'),
          name: String(error?.name || 'Error'),
          message: redact(error?.message || error)
        }));
      }
      let validJson = false;
      try { JSON.parse(responseBody); validJson = true; } catch {}
      if (!response.ok || !validJson) {
        const diagnostic = {
          source: 'Hexium HTTP response',
          endpoint: HEX + path,
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get('content-type'),
          elapsedMs: Date.now() - started,
          body: redact(responseBody),
          truncated: responseBody.length > 3000
        };
        throw new UpstreamError('Hexium login response: ' + JSON.stringify(diagnostic));
      }
    }
    return response;
  }
  async api(id, path, method = 'GET', body) {
    const { user, cookie } = await this.credentials(id);
    let r = await this.raw(cookie, path, method, body, user.csrf);
    // A 403 with a challenge token is a rejection; retry that same operation once.
    const token = r.headers.get('x-csrf-token');
    if (method === 'POST' && r.status === 403 && token) {
      await r.body?.cancel(); user.csrf = token; this.put('user', id, user);
      r = await this.raw(cookie, path, method, body, token);
    }
    if (!r.ok) {
      await r.body?.cancel();
      const ambiguous = r.status >= 500 || r.status === 408 || (r.status >= 300 && r.status < 400);
      throw new UpstreamError(`Hexium returned HTTP ${r.status}.`, method === 'POST' && ambiguous, method === 'POST' && !ambiguous);
    }
    const text = await r.text();
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new UpstreamError('Hexium returned an unexpected response.', method === 'POST'); }
  }
  async identity(id) {
    const u = await this.api(id, '/apisite/users/v1/users/authenticated');
    if (Number(u?.id) !== id) throw new UpstreamError('Hexium account validation failed. Log in again.');
    return { id, name: String(u.name), displayName: String(u.displayName || u.name) };
  }
  async pages(id, path) {
    let cursor = '', items = [], seen = new Set();
    for (let page = 0; page < 100; page++) {
      const r = await this.api(id, path + encodeURIComponent(cursor));
      if (!Array.isArray(r?.data)) throw new UpstreamError('Hexium returned an unexpected list.');
      items.push(...r.data);
      if (!r.nextPageCursor) return items;
      if (seen.has(r.nextPageCursor)) throw new UpstreamError('Hexium pagination repeated a cursor.');
      cursor = r.nextPageCursor; seen.add(cursor);
    }
    throw new UpstreamError('Inventory or trade list exceeds the supported page limit.');
  }
  inventory(id) { return this.pages(id, `/apisite/inventory/v1/users/${id}/assets/collectibles?limit=100&assetType=null&cursor=`); }
  inbound(id) { return this.pages(id, '/apisite/trades/v1/trades/inbound?cursor='); }
  async values() {
    if (this.valuesCache && Date.now() - this.valuesCache.time < 60000) {
      return this.valuesCache;
    }

    const signal = AbortSignal.timeout(25000);
    const started = Date.now();
    let response, text;

    try {
      response = await fetch(VALUES, {
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store'
        },
        redirect: 'manual',
        signal
      });
      text = await response.text();
    } catch (error) {
      throw new UpstreamError(
        'Heximons connection failed: ' + JSON.stringify({
          endpoint: VALUES,
          status: response?.status ?? null,
          elapsedMs: Date.now() - started,
          timedOut: signal.aborted,
          name: String(error?.name || 'Error'),
          message: String(error?.message || error).slice(0, 1000)
        })
      );
    }

    const failure = reason => new UpstreamError(
      'Heximons response: ' + JSON.stringify({
        reason,
        endpoint: VALUES,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type'),
        cfRay: response.headers.get('cf-ray'),
        cfMitigated: response.headers.get('cf-mitigated'),
        elapsedMs: Date.now() - started,
        body: text.slice(0, 3000),
        truncated: text.length > 3000
      })
    );

    if (!response.ok) throw failure('HTTP error');

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw failure('Response was not valid JSON');
    }

    if (
      !data?.assets ||
      typeof data.assets !== 'object' ||
      Array.isArray(data.assets)
    ) {
      throw failure('JSON did not contain the expected assets map');
    }

    this.valuesCache = { data, time: Date.now() };
    return this.valuesCache;
  }
  valued(items, values) {
    return items.map(x => {
      const v = effectiveValue(x, values);
      must(Number.isSafeInteger(x.userAssetId) && Number.isSafeInteger(x.assetId), 'Invalid inventory item.');
      return { userAssetId: x.userAssetId, assetId: x.assetId, name: String(x.name), serialNumber: x.serialNumber, rap: x.recentAveragePrice, value: v.amount, units: v.units, source: v.source };
    });
  }
  locked(id, exclude) {
    const ids = new Set();
    for (const g of this.all('game')) if (g.id !== exclude && activeStates.has(g.state)) {
      for (const p of [g.a, g.b]) if (p?.id === id) {
        p.items.forEach(x => ids.add(x.userAssetId));
        p.returnIds.forEach(x => ids.add(x));
      }
    }
    return ids;
  }
  async participant(id, selected, snapshot) {
    await this.identity(id);
    must(Array.isArray(selected) && selected.length >= 1 && selected.length <= 100, 'Select at least one stake item.');
    must(selected.every(Number.isSafeInteger) && new Set(selected).size === selected.length, 'Invalid stake selection.');
    const user = this.get('user', id);
    const inv = this.valued(await this.inventory(id), snapshot.data);
    const byId = new Map(inv.map(x => [x.userAssetId, x]));
    const locked = this.locked(id);
    const items = selected.map(x => {
      must(byId.has(x), 'A selected item is no longer owned.');
      must(!locked.has(x), 'An item is reserved for another game.');
      must(!user.returnIds?.includes(x), 'Stake items cannot also be selected as return items.');
      must(byId.get(x).units > 0, 'Stake items must have a positive value.');
      return byId.get(x);
    });
    must(Array.isArray(user.returnIds) && user.returnIds.length >= 1 && user.returnIds.length <= 3, 'Choose one to three small return items first.');
    const returnIds = user.returnIds.filter(x => byId.has(x) && byId.get(x).units < 150000 && !selected.includes(x) && !locked.has(x));
    must(returnIds.length >= 1, 'At least one selected return item must still be owned, worth under 150, and available.');
    const total = items.reduce((sum, x) => sum + x.units, 0);
    must(Number.isSafeInteger(total), 'Stake total is too large.');
    return { id, name: user.name, displayName: user.displayName, items, returnIds, total };
  }
  async authenticated(request) {
    const token = cookieToken(request);
    must(/^[a-f0-9]{64}$/.test(token), 'Log in to continue.', 401);
    const key = await hash(token), session = this.get('session', key);
    must(session && session.expires > Date.now(), 'Your session expired. Log in again.', 401);
    return { ...session, sessionKey: key };
  }
  rate(key, limit, period) {
    const now = Date.now(); let r = this.get('rate', key);
    if (!r || r.until < now) r = { count: 0, until: now + period };
    must(r.count < limit, 'Too many requests. Wait and try again.', 429);
    r.count++; this.put('rate', key, r);
  }
  publicGame(g) {
    const p = person => person ? { id: person.id, name: person.name, displayName: person.displayName, items: person.items, total: person.total, odds: g.b ? person.total / (g.a.total + g.b.total) : null } : null;
    return { id: g.id, state: g.state, created: g.created, expires: g.expires, a: p(g.a), b: p(g.b), commitment: g.commitment, clientA: g.clientA, clientB: g.clientB || null,
      nonce: g.nonce, matchingRule: g.state === 'open' ? 'floor-range-3pct-v1' : g.matchingRule || 'strict-1pct-v1', valueTime: g.valueTime, winnerId: g.winnerId || null, error: g.error || null,
      tradeId: g.tradeId || null, animationUntil: g.animationUntil || null,
      proof: g.b && g.state !== 'open' ? { serverSeed: g.seed, message: proofMessage(g), ...g.draw, total: g.a.total + g.b.total, threshold: g.a.total, winnerId: g.winnerId } : null };
  }
  async fetch(request) {
    return this.run(async () => {
      try { return await this.route(request); }
      catch (error) { return json({ error: error instanceof AppError || error instanceof UpstreamError ? error.message : 'Unexpected server error.' }, error.status || 502); }
    });
  }
  async route(request) {
    const path = new URL(request.url).pathname;
    const post = request.method === 'POST';
    this.rate('ip:' + request.headers.get('X-Flip-IP'), 180, 60000);
    const body = post ? await limitedBody(request) : {};
    if (path === '/api/login' && post) {
      this.rate('login:' + request.headers.get('X-Flip-IP'), 8, 60000);
      const cookie = body.cookie;
      must(typeof cookie === 'string' && cookie.length >= 10 && cookie.length <= 16000 && !/[\r\n;\x00-\x1f]/.test(cookie), 'Paste the Hexium cookie value only.');
      const r = await this.raw(cookie, '/apisite/users/v1/users/authenticated');
      if (!r.ok) { await r.body?.cancel(); throw new AppError('Hexium rejected the login cookie.', 401); }
      const u = await r.json();
      must(Number.isSafeInteger(u?.id) && u.id > 0 && typeof u.name === 'string', 'Unexpected Hexium login response.', 502);
      const old = this.get('user', u.id);
      const user = { id: u.id, name: u.name, displayName: u.displayName || u.name, cookie: await this.seal(cookie, u.id), returnIds: old?.returnIds || [], expires: Date.now() + SESSION_MS };
      this.put('user', u.id, user);
      const token = random(); this.put('session', await hash(token), { userId: u.id, expires: user.expires });
      await this.ctx.storage.setAlarm(Date.now() + 30000);
      return json({ user: { id: u.id, name: u.name, displayName: user.displayName } }, 200, { 'Set-Cookie': sessionCookie(token) });
    }
    if (path === '/api/games' && !post) {
      await this.expire();
      return json({ games: this.all('game').sort((a, b) => Number(activeStates.has(b.state)) - Number(activeStates.has(a.state)) || b.created - a.created).slice(0, 100).map(g => this.publicGame(g)) });
    }
    if (path.startsWith('/api/game/') && !post) {
      const g = this.get('game', path.slice('/api/game/'.length));
      must(g, 'Game not found.', 404); return json(this.publicGame(g));
    }
    const session = await this.authenticated(request), id = session.userId;
    if (path === '/api/me' && !post) {
      const user = this.get('user', id);
      must(user && user.expires > Date.now(), 'Log in again.', 401);
      return json({ user: { id, name: user.name, displayName: user.displayName }, returnIds: user.returnIds, expires: session.expires });
    }
    if (path === '/api/inventory' && !post) {
      this.rate('inventory:' + id, 12, 60000);
      await this.identity(id); const snapshot = await this.values();
      return json({ items: this.valued(await this.inventory(id), snapshot.data), locked: [...this.locked(id)], valueTime: snapshot.time });
    }
    if (path === '/api/returns' && post) {
      this.rate('mutate:' + id, 20, 60000);
      must(Array.isArray(body.ids) && body.ids.length >= 1 && body.ids.length <= 3 && body.ids.every(Number.isSafeInteger) && new Set(body.ids).size === body.ids.length, 'Select one to three different return item copies.');
      await this.identity(id);
      const v = await this.values(), items = this.valued(await this.inventory(id), v.data), locked = this.locked(id);
      must(body.ids.every(x => items.some(i => i.userAssetId === x && i.units < 150000) && !locked.has(x)), 'Return items must be available and worth under 150.');
      const user = this.get('user', id); user.returnIds = body.ids; this.put('user', id, user);
      return json({ ok: true });
    }
    if (path === '/api/create' && post) {
      this.rate('mutate:' + id, 20, 60000);
      must(!this.all('game').some(g => activeStates.has(g.state) && (g.a.id === id || g.b?.id === id)), 'Finish or cancel your current game first.');
      must(this.all('game').filter(g => activeStates.has(g.state)).length < 100, 'Lobby is full.');
      must(typeof body.clientSeed === 'string' && /^[a-f0-9]{64}$/.test(body.clientSeed), 'Invalid client seed.');
      const snapshot = await this.values(), a = await this.participant(id, body.ids, snapshot);
      const seed = random(), gameId = crypto.randomUUID();
      const g = { id: gameId, state: 'open', a, b: null, seed, commitment: await hash(seed), clientA: body.clientSeed, nonce: 0, matchingRule: 'floor-range-3pct-v1', created: Date.now(), expires: Date.now() + OPEN_MS, valueTime: snapshot.time, values: snapshot.data };
      // Item valuations in the commitment are revalidated at join.
      delete g.values;
      this.put('game', g.id, g); await this.ctx.storage.setAlarm(Date.now() + 30000);
      return json(this.publicGame(g));
    }
    if (path === '/api/join' && post) {
      this.rate('mutate:' + id, 20, 60000);
      const g = this.get('game', body.gameId);
      must(g?.state === 'open' && g.expires > Date.now(), 'This game is no longer open.');
      must(g.a.id !== id, 'You cannot join your own game.');
      must(!this.all('game').some(x => activeStates.has(x.state) && (x.a.id === id || x.b?.id === id)), 'Finish your current game first.');
      must(body.commitment === g.commitment, 'The game commitment changed.');
      must(typeof body.clientSeed === 'string' && /^[a-f0-9]{64}$/.test(body.clientSeed), 'Invalid client seed.');
      // Never change the creator's committed values without their consent. If prices have changed,
      // close the offer before a second player is committed and ask the creator to recreate it.
      const snapshot = await this.values();
      const makerInv = await this.inventory(g.a.id); await this.identity(g.a.id);
      const makerNow = this.valued(makerInv, snapshot.data);
      const valid = g.a.items.every(x => makerNow.some(i => i.userAssetId === x.userAssetId && i.assetId === x.assetId && i.units === x.units));
      if (!valid) {
        g.state = 'cancelled'; g.error = 'Creator stake ownership or values changed. Create a new game.';
        this.put('game', g.id, g); throw new AppError(g.error);
      }
      const b = await this.participant(id, body.ids, snapshot);
      g.matchingRule = 'floor-range-3pct-v1';
      const range = joinRange(g.a.total);
      must(roundedStakeMatch(g.a.total, b.total), `Your stake must be within the displayed join range: ${range.min}-${range.max}.`);
      must(Number.isSafeInteger(g.a.total + b.total), 'Combined stake is too large.');
      // Return items are always checked using current values, not frozen stake overrides.
      const winnerReturns = this.valued(makerInv, snapshot.data).filter(i => g.a.returnIds.includes(i.userAssetId) && i.units < 150000);
      must(winnerReturns.length >= 1, 'Creator needs an available small return item.');
      const bCurrent = this.valued(await this.inventory(id), snapshot.data);
      must(b.returnIds.filter(x => bCurrent.some(i => i.userAssetId === x && i.units < 150000)).length >= 1, 'You need an available small return item.');
      g.b = b; g.clientB = body.clientSeed;
      g.draw = await draw(g.seed, proofMessage(g), g.a.total + g.b.total);
      g.winnerId = g.draw.ticket < g.a.total ? g.a.id : g.b.id;
      const winner = g.winnerId === g.a.id ? g.a : g.b, loser = g.winnerId === g.a.id ? g.b : g.a;
      const winnerInv = g.winnerId === g.a.id ? this.valued(makerInv, snapshot.data) : bCurrent;
      const small = winnerInv.filter(i => winner.returnIds.includes(i.userAssetId) && i.units < 150000).sort((a, b) => a.units - b.units || a.userAssetId - b.userAssetId)[0];
      must(small, 'Winner has no available return item.');
      g.payout = { loserId: loser.id, winnerId: winner.id, stakeIds: loser.items.map(i => i.userAssetId), returnId: small.userAssetId };
      g.state = 'settling'; g.stage = 'prepared'; g.animationUntil = Date.now() + 7000; g.attempts = 0;
      this.put('game', g.id, g); await this.ctx.storage.setAlarm(Date.now() + 1000);
      // Persist the selected outcome before any side effect; settlement survives browser disconnects.
      this.ctx.waitUntil(this.run(() => this.settle(g.id)));
      return json(this.publicGame(g));
    }
    if (path === '/api/cancel' && post) {
      const g = this.get('game', body.gameId);
      must(g && g.a.id === id && g.state === 'open', 'Only the creator can cancel an open game.');
      g.state = 'cancelled'; g.error = 'Cancelled by creator.'; this.put('game', g.id, g); return json({ ok: true });
    }
    if (path === '/api/reconcile' && post) {
      this.rate('reconcile:' + id, 3, 60000);
      const g = this.get('game', body.gameId);
      must(g && (g.a.id === id || g.b?.id === id) && ['review', 'reconciling'].includes(g.state), 'This game does not need reconciliation.');
      await this.settle(g.id, true); return json(this.publicGame(this.get('game', g.id)));
    }
    if (path === '/api/logout' && post) {
      must(!this.all('game').some(g => ['settling', 'reconciling', 'review'].includes(g.state) && (g.a.id === id || g.b?.id === id)), 'Resolve your pending payout before disconnecting.');
      for (const g of this.all('game')) if (g.state === 'open' && g.a.id === id) { g.state = 'cancelled'; g.error = 'Creator disconnected.'; this.put('game', g.id, g); }
      for (const s of [...this.sql.exec("SELECT id,data FROM records WHERE kind='session'")]) if (JSON.parse(s.data).userId === id) this.del('session', s.id);
      this.del('user', id); return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    }
    throw new AppError('Not found.', 404);
  }
  async transferred(g) {
    const [winner, loser] = await Promise.all([this.inventory(g.payout.winnerId), this.inventory(g.payout.loserId)]);
    const w = new Set(winner.map(x => x.userAssetId)), l = new Set(loser.map(x => x.userAssetId));
    return g.payout.stakeIds.every(x => w.has(x) && !l.has(x)) && l.has(g.payout.returnId) && !w.has(g.payout.returnId);
  }
  async findTrade(g) {
    if (g.tradeId) {
      const t = await this.api(g.payout.winnerId, `/apisite/trades/v1/trades/${g.tradeId}`);
      if (!exactTrade(t, g.payout)) throw new UpstreamError('Trade contents changed. Manual review required.', true);
      return t;
    }
    const candidates = await this.inbound(g.payout.winnerId), matches = [];
    for (const candidate of candidates) {
      if (g.baseline.includes(Number(candidate.id)) || Number(candidate.user?.id) !== g.payout.loserId) continue;
      if (!candidate.isActive || candidate.status !== 'Open') continue;
      const t = await this.api(g.payout.winnerId, `/apisite/trades/v1/trades/${Number(candidate.id)}`);
      const created = Date.parse(t?.created);
      if (Number.isFinite(created) && created >= g.sendStarted - 5000 && exactTrade(t, g.payout)) matches.push(t);
    }
    if (matches.length > 1) throw new UpstreamError('Multiple matching trades found. Manual review required.', true);
    return matches[0] || null;
  }
  async settle(gameId, manual = false) {
    const g = this.get('game', gameId);
    if (!g || (!['settling', 'reconciling'].includes(g.state) && !(manual && g.state === 'review'))) return;
    try {
      g.attempts++;
      if (g.stage === 'prepared') {
        await this.identity(g.payout.loserId); await this.identity(g.payout.winnerId);
        const [loser, winner] = await Promise.all([this.inventory(g.payout.loserId), this.inventory(g.payout.winnerId)]);
        if (!g.payout.stakeIds.every(x => loser.some(i => i.userAssetId === x)) || !winner.some(i => i.userAssetId === g.payout.returnId)) throw new UpstreamError('Stake or return item is no longer owned.');
        const snapshot = await this.values();
        const small = this.valued(winner, snapshot.data).find(i => i.userAssetId === g.payout.returnId);
        if (!small || small.units >= 150000) throw new UpstreamError('Return item is no longer worth under 150.');
        g.baseline = (await this.inbound(g.payout.winnerId)).map(t => Number(t.id));
        g.sendStarted = Date.now(); g.stage = 'sending'; this.put('game', g.id, g);
        const response = await this.api(g.payout.loserId, '/apisite/trades/v1/trades/send', 'POST', { offers: [
          { userId: g.payout.loserId, userAssetIds: g.payout.stakeIds, robux: null },
          { userId: g.payout.winnerId, userAssetIds: [g.payout.returnId], robux: null }
        ] });
        // A 200 with an empty body is expected. Discovery verifies the complete offers regardless of any returned ID.
        void response; g.stage = 'sent'; this.put('game', g.id, g);
      }
      if (await this.transferred(g)) { g.state = 'completed'; g.stage = 'completed'; delete g.error; this.put('game', g.id, g); return; }
      const trade = await this.findTrade(g);
      if (!trade) throw new UpstreamError('Waiting to confirm whether Hexium created the payout trade.', true);
      if (!Number.isSafeInteger(Number(trade.id)) || Number(trade.id) <= 0) throw new UpstreamError('Invalid payout trade ID.', true);
      g.tradeId = Number(trade.id); this.put('game', g.id, g);
      if (trade.status === 'Completed' || trade.status === 'Accepted') {
        g.stage = 'accepted'; this.put('game', g.id, g);
        if (await this.transferred(g)) { g.state = 'completed'; g.stage = 'completed'; delete g.error; }
        else throw new UpstreamError('Trade accepted; waiting for inventories to update.', true);
      } else if (trade.status === 'Open' && trade.isActive) {
        if (g.stage === 'accepting' || g.stage === 'accepted') throw new UpstreamError('Waiting to confirm the previous acceptance request. If it stays open, resolve this trade in Hexium.', true);
        // Exact account IDs, copy IDs, and currency were checked by findTrade.
        g.stage = 'accepting'; this.put('game', g.id, g);
        await this.api(g.payout.winnerId, `/apisite/trades/v1/trades/${g.tradeId}/accept`, 'POST');
        g.stage = 'accepted'; this.put('game', g.id, g);
        if (await this.transferred(g)) { g.state = 'completed'; g.stage = 'completed'; delete g.error; }
        else throw new UpstreamError('Trade accepted; waiting for inventories to update.', true);
      } else if (['Declined', 'Expired', 'Cancelled', 'Rejected'].includes(trade.status)) {
        const error = new UpstreamError('Payout trade was closed or declined.');
        error.terminalNoTransfer = true; throw error;
      } else throw new UpstreamError('Unrecognized trade status. Payout needs review.', true);
    } catch (error) {
      const effectStarted = ['sending', 'sent', 'accepting', 'accepted'].includes(g.stage);
      const uncertain = error.uncertain || (effectStarted && !error.rejectedWrite);
      // An acceptance rejection leaves a sent trade outstanding; retain reservations until it is reconciled.
      const outstanding = error.rejectedWrite && g.stage === 'accepting';
      // A definite HTTP rejection cancels the round; uncertain writes keep reservations and the proof.
      if (error.terminalNoTransfer) g.state = 'cancelled';
      else if (outstanding) g.state = 'review';
      else if (uncertain) g.state = g.attempts >= 10 ? 'review' : 'reconciling';
      else g.state = 'cancelled';
      g.error = error instanceof UpstreamError ? error.message : 'Payout needs review.';
      if (g.state === 'review') g.error += ' Log in again if needed, then use Recheck payout. No automatic resend will occur.';
    }
    this.put('game', g.id, g);
    if (['settling', 'reconciling'].includes(g.state)) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }
  async expire() {
    for (const g of this.all('game')) {
      if (g.state === 'open' && g.expires < Date.now()) { g.state = 'cancelled'; g.error = 'Game expired.'; this.put('game', g.id, g); }
      // Retain public proof history for 30 days; unresolved payouts are never automatically deleted.
      if (!activeStates.has(g.state) && g.created < Date.now() - 30 * 86400000) this.del('game', g.id);
    }
  }
  async alarm() {
    return this.run(async () => {
      await this.expire();
      for (const g of this.all('game')) if (['settling', 'reconciling'].includes(g.state)) await this.settle(g.id);
      for (const kind of ['session', 'rate']) for (const r of [...this.sql.exec('SELECT id,data FROM records WHERE kind=?', kind)]) {
        const d = JSON.parse(r.data); if ((d.expires || d.until) < Date.now()) this.del(kind, r.id);
      }
      for (const u of this.all('user')) if (u.expires < Date.now()) this.del('user', u.id);
      if (this.all('game').some(g => ['open', 'settling', 'reconciling'].includes(g.state)) || this.all('user').length) await this.ctx.storage.setAlarm(Date.now() + 30000);
    });
  }
}

const HTML = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"><meta name=\"theme-color\" content=\"#17191f\"><title>Hexium Flip</title>\n<style>\n:root{color-scheme:dark;--bg:#15171c;--surface:#1a1d24;--raised:#22262f;--line:#292d38;--muted:#9296a3;--green:#00e889;--gold:#ffcc65;--text:#f4f5f7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}button,input,textarea{font:inherit}button{cursor:pointer;min-height:44px;border:1px solid transparent;border-radius:8px;padding:10px 18px;background:#292d39;color:var(--text);font-weight:650}button:hover{filter:brightness(1.1)}button:disabled{opacity:.4;cursor:not-allowed}.primary{background:var(--green);color:#08231a}.quiet{background:transparent;border-color:var(--line)}.icon-button{padding:7px 12px;font-size:25px;background:transparent;min-width:44px;line-height:1}.muted{color:var(--muted)}.green{color:var(--green)}.error{color:#ffaba6}small,.small{font-size:14px}.row{display:flex;justify-content:space-between;align-items:center;gap:14px}.actions{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap}.topbar{height:86px;padding:16px max(24px,calc((100vw - 1180px)/2));border-bottom:1px solid #22252d;display:flex;justify-content:space-between;align-items:center;gap:16px;background:#191c23}.brand{display:flex;align-items:center;gap:11px;line-height:.95;letter-spacing:-.7px}.brand-mark{width:34px;height:34px;border:3px solid var(--green);border-radius:50%;display:grid;place-items:center;color:var(--green);font-size:21px;font-weight:900;transform:rotate(-18deg)}.brand strong{display:block;color:var(--green);font-size:21px;font-style:italic}.brand span{font-size:19px;font-weight:850}.account-area{display:flex;align-items:center;gap:8px}.account-label{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.account-area .avatar{width:36px;height:36px}.main{max-width:1180px;margin:0 auto;padding:28px 24px 116px}.preview-note{display:none;padding:9px 16px;text-align:center;font-size:14px;background:#213229;color:#b0f9d5}.preview-note.visible{display:block}.page-heading{display:flex;gap:16px;justify-content:space-between;align-items:center;margin-bottom:22px}.page-heading h1{font-size:27px;letter-spacing:-.8px;margin:0 0 2px}.page-heading p{margin:0;color:var(--muted);font-size:14px}.desktop-nav{display:flex;gap:8px;margin-bottom:24px}.desktop-nav button{background:transparent;color:var(--muted);border-color:var(--line)}.desktop-nav .active{color:var(--green);background:#00e8890c;border-color:#00e88955}.round-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}.round-card{background:var(--surface);border:1px solid #20242c;border-radius:9px;padding:22px 18px;min-height:326px;display:flex;flex-direction:column;align-items:center;position:relative}.card-status{align-self:flex-end;color:var(--muted);font-size:12px;height:20px;margin-bottom:3px}.card-players{display:flex;gap:22px;align-items:center;justify-content:center;margin:0 0 19px}.avatar{width:62px;height:62px;border:2px solid #242832;border-radius:50%;background:#15181e;display:grid;place-items:center;position:relative;overflow:hidden}.avatar.winner{border-color:var(--green)}.avatar img{width:100%;height:100%;object-fit:contain}.avatar .initial{font-weight:750;color:#bec3ce}.versus{font-size:14px;font-weight:700;color:#808590}.thumb-row{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;min-height:67px;max-width:100%;margin-bottom:14px}.thumb{display:grid;place-items:center;position:relative;background:#14171d;border:1px solid #252933;border-radius:50%;overflow:hidden;flex:none}.thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:5px}.thumb .initial{font-size:14px;font-weight:700;color:#606779;max-width:90%;overflow:hidden}.image-ready>.initial{visibility:hidden}.thumb.small-thumb{width:62px;height:62px}.more-items{font-size:13px;color:var(--muted)}.card-value{font-size:18px;font-weight:750;display:flex;align-items:center;gap:7px;margin-top:auto}.gem{width:17px;height:15px;background:var(--green);clip-path:polygon(20% 0,80% 0,100% 35%,50% 100%,0 35%);display:inline-block;flex:none}.range{color:#858995;font-weight:650;font-size:15px;margin:4px 0 17px}.empty{padding:64px 20px;text-align:center;border:1px dashed var(--line);border-radius:10px;color:var(--muted)}.empty h2{color:var(--text);font-size:20px;margin:0 0 8px}.empty p{margin:0 0 18px}.bottom-nav{position:fixed;bottom:0;left:0;right:0;z-index:5;display:none;background:#13161ceF;border-top:1px solid #252832;padding:10px 10px max(10px,env(safe-area-inset-bottom));backdrop-filter:blur(16px)}.bottom-nav button{flex:1;background:transparent;border-radius:0;color:#9296a3;font-size:13px;padding:5px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px}.bottom-nav svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.8}.bottom-nav button.active{color:var(--green)}.return-panel{background:var(--surface);border:1px solid #242832;border-radius:10px;padding:24px}.return-panel h2{font-size:21px;margin:0 0 6px}.return-panel p{margin:0;color:var(--muted);font-size:14px}.return-toolbar{margin:18px 0;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.selection-count{font-size:14px;color:var(--green);font-weight:650}.item-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:12px}.item-tile{padding:0;text-align:left;background:#16191f;border:1px solid #2b2f3b;border-radius:9px;position:relative;overflow:hidden;display:flex;flex-direction:column;min-width:0}.item-tile .thumb{width:100%;height:130px;border:0;border-radius:0;background:#181b23}.item-tile .thumb img{padding:12px}.tile-copy{padding:12px;display:flex;flex-direction:column;gap:5px;width:100%}.tile-name{font-size:14px;line-height:1.35;min-height:38px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-weight:650}.tile-value{display:flex;align-items:center;gap:7px;font-size:14px;font-weight:700}.tile-value .gem{width:12px;height:11px}.tile-id{font-size:12px;color:#9296a3}.item-tile.selected{border-color:var(--green);box-shadow:0 0 0 1px #00e88966;background:#1a3027}.select-mark{position:absolute;top:8px;right:8px;border:1px solid #596170;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:#12151c;z-index:1;font-size:14px}.selected .select-mark{background:var(--green);border-color:var(--green);color:#08231a}.item-tile:disabled .thumb,.item-tile:disabled .tile-copy{opacity:.5}.item-tile:disabled{opacity:1}.reserved{position:absolute;top:8px;left:8px;color:#b2b7c4;font-size:11px;background:#11151e;padding:3px 6px;border-radius:4px;z-index:1}.notice{padding:12px 14px;background:#342422;border:1px solid #71463f;border-radius:8px;color:#ffc1b9;margin-bottom:18px;font-size:14px;overflow-wrap:anywhere}.information{font-size:14px;color:var(--muted);margin:16px 0 0}.dialog-top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:18px}.dialog-top h2{font-size:22px;margin:0}.dialog-top p{margin:4px 0 0;color:var(--muted);font-size:14px}dialog{background:#14171c;color:var(--text);border:1px solid #2b303b;border-radius:13px;width:min(840px,calc(100% - 32px));max-height:90dvh;padding:26px;overflow:auto}dialog::backdrop{background:#07090dd9;backdrop-filter:blur(5px)}.picker-toolbar{position:sticky;top:-26px;background:#14171cf2;padding:12px 0 16px;z-index:2;display:flex;justify-content:space-between;gap:15px;align-items:center}.picker-toolbar .total{font-weight:750;font-size:20px;display:flex;align-items:center;gap:7px}.picker-footer{position:sticky;bottom:-26px;background:#14171cf5;border-top:1px solid var(--line);padding:18px 0 0;margin-top:18px;display:flex;align-items:center;justify-content:space-between;gap:15px}.picker-footer p{font-size:14px;color:var(--muted);margin:0}.picker-footer button{min-width:170px}.detail-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.detail-header .brand{transform:scale(.85);transform-origin:left}.detail-players{display:grid;grid-template-columns:minmax(0,1fr) 160px minmax(0,1fr);align-items:center;text-align:center;gap:16px;margin:25px 0 30px}.detail-player{min-width:0}.detail-player .avatar{width:90px;height:90px;margin:auto auto 12px}.detail-player strong{display:block;font-size:17px;overflow-wrap:anywhere}.detail-player small{display:block;color:var(--muted);font-size:13px}.coin-scene{perspective:700px;display:grid;place-items:center}.coin{position:relative;width:132px;height:132px;transform-style:preserve-3d;transform:rotateY(0);font-family:ui-monospace,monospace}.coin.winner-b{transform:rotateY(180deg)}.coin-face{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:50%;border:7px solid #b08230;background:radial-gradient(circle at 35% 28%,#ffeab0,#f5bd41 65%,#c68e22);color:#47300d;box-shadow:inset 0 0 0 3px #ffe5a2,0 0 0 3px #f5c96b22;backface-visibility:hidden;-webkit-backface-visibility:hidden;transform:translateZ(3px)}.coin-face::before{content:'';position:absolute;inset:12px;border:2px solid #ad791d;border-radius:50%;opacity:.4}.coin-face small{font:11px system-ui,sans-serif;font-weight:650;color:inherit;margin-bottom:3px;z-index:1}.coin-face strong{font-size:24px;font-weight:850;line-height:1.1;text-align:center;max-width:80%;overflow-wrap:anywhere;z-index:1}.coin-back{background:radial-gradient(circle at 35% 28%,#b0ffe0,#00e889 65%,#00a566);border-color:#008956;color:#083323;box-shadow:inset 0 0 0 3px #87ffce,0 0 0 3px #00e88922;transform:rotateY(180deg) translateZ(3px)}.coin-back::before{border-color:#08613e}.coin.spin{animation:flip .7s linear infinite;animation-delay:var(--coin-delay,0s)}@keyframes flip{from{transform:rotateY(0)}to{transform:rotateY(360deg)}}.mini-coin .coin{width:44px;height:44px;margin:2px 0 14px}.mini-coin .coin-face{border-width:3px;box-shadow:inset 0 0 0 1px #ffe5a2,0 0 0 2px #f5c96b22}.mini-coin .coin-face::before{inset:4px;border-width:1px}.mini-coin .coin-face small{display:none}.mini-coin .coin-face strong{font-size:11px}.detail-state{text-align:center;font-size:16px;font-weight:650;margin-bottom:16px}.round-hash{text-align:center;font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 0 23px}.detail-stats{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-bottom:18px}.detail-stat{display:flex;align-items:center;justify-content:center;gap:10px;background:#171a20;border:1px solid #232630;border-radius:8px;padding:17px 10px;font-size:15px}.detail-stat strong{display:flex;align-items:center;gap:6px}.stake-columns{display:grid;grid-template-columns:1fr 1fr;gap:15px}.stake-item{padding:12px;background:#171a20;border:1px solid #232630;border-radius:8px;margin-bottom:10px}.stake-item .row{justify-content:flex-start;gap:12px}.stake-item .thumb{width:58px;height:58px;border:0;background:transparent}.stake-item strong{display:flex;align-items:center;gap:6px;font-size:15px}.stake-item p{font-size:14px;margin:6px 0 0;font-weight:600}.detail-actions{margin-top:24px}.detail-error{margin:16px 0 0}.pill{padding:4px 9px;background:#232733;border-radius:5px;font-size:12px;color:#aeb5c5}.fair-copy{font-size:14px;color:var(--muted);margin:0 0 17px}label{display:block;font-size:14px;margin:12px 0 7px}input,textarea{width:100%;background:#1b1f28;border:1px solid #343947;border-radius:8px;color:var(--text);padding:12px;font:inherit}textarea{min-height:150px;font-size:13px;resize:vertical}pre{background:#1b1f28;padding:15px;border-radius:8px;font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.form-error{color:#ffaba6;margin:12px 0 0;font-size:14px;overflow-wrap:anywhere}#toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);width:max-content;max-width:calc(100% - 32px);max-height:45vh;overflow:auto;z-index:100;background:#2a303c;border:1px solid #525f71;border-radius:10px;padding:12px 17px;font-size:14px;overflow-wrap:anywhere;box-shadow:0 10px 30px #0005}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--green);outline-offset:3px}[hidden]{display:none!important}@media(min-width:900px){.main{padding-bottom:60px}.return-panel .item-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}#toast{bottom:24px}}@media(max-width:650px){.topbar{height:82px;padding:15px 20px}.account-label{max-width:100px}.account-area .avatar{display:none}.account-area #logout{padding:9px;font-size:13px}.brand strong{font-size:20px}.brand span{font-size:18px}.main{padding:23px 16px 112px}.desktop-nav{display:none}.bottom-nav{display:flex}.page-heading h1{font-size:24px}.page-heading{gap:8px}.page-heading button{padding:11px 14px;font-size:14px}.round-grid{grid-template-columns:1fr;gap:16px}.round-card{min-height:325px;padding:20px 18px}.return-panel{padding:18px}.item-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.item-tile .thumb{height:122px}dialog{width:100%;max-width:none;height:100dvh;max-height:100dvh;border:0;border-radius:0;margin:0;padding:22px 18px max(22px,env(safe-area-inset-bottom));}.detail-players{grid-template-columns:minmax(0,1fr) 118px minmax(0,1fr);gap:7px;margin:28px 0}.detail-player .avatar{width:70px;height:70px}.detail-player strong{font-size:15px}.detail-player small{font-size:12px}.coin{width:110px;height:110px}.coin-face{border-width:6px}.coin-face strong{font-size:20px}.detail-stat{gap:7px;font-size:13px;padding:15px 8px}.detail-stat .gem{width:13px;height:12px}.stake-item{padding:11px}.stake-item .row{gap:8px}.stake-item .thumb{width:47px;height:47px}.stake-item strong{font-size:13px}.stake-item p{font-size:13px}.picker-footer{bottom:calc(-22px - env(safe-area-inset-bottom));padding:15px 0 max(12px,env(safe-area-inset-bottom))}.picker-footer button{min-width:130px;font-size:14px}.picker-toolbar{top:-22px}.page-heading p{font-size:13px}.detail-stats,.stake-columns{gap:11px}.topbar .primary{min-width:110px}}@media(prefers-reduced-motion:reduce){.coin.spin{animation:none}}\n</style></head><body>\n<div class=\"preview-note\" id=\"previewNote\">Interactive preview · sample items and rounds · no real trades</div>\n<header class=\"topbar\"><div class=\"brand\"><div class=\"brand-mark\">H</div><div><strong>HEXIUM</strong><span>Flip</span></div></div><div class=\"account-area\"><span id=\"account\" class=\"account-label muted\"></span><button id=\"connect\" class=\"primary\">Login</button><button id=\"logout\" class=\"quiet\" hidden>Disconnect</button></div></header>\n<main class=\"main\"><div id=\"globalError\" class=\"notice\" hidden></div><nav class=\"desktop-nav\" aria-label=\"Sections\"><button data-tab=\"open\" class=\"active\">Coinflips</button><button data-tab=\"returns\">Return items</button><button data-tab=\"history\">Recent rounds</button></nav>\n<section id=\"roundsSection\"><div class=\"page-heading\"><div><h1 id=\"roundsTitle\">Coinflips</h1><p>3% range · weighted by item value</p></div><button class=\"primary\" id=\"create\">Create coinflip</button></div><div id=\"games\" class=\"round-grid\"></div></section>\n<section id=\"returnsSection\" class=\"return-panel\" hidden><h2>Return items</h2><p>Choose 1–3 item copies worth under 150. One is returned when you win; these items stay out of your wager picker.</p><div class=\"return-toolbar\"><span id=\"returnCount\" class=\"selection-count\">0 selected · max 3</span><div class=\"actions\"><button id=\"refreshReturns\" class=\"quiet\">Refresh</button><button id=\"saveReturns\" class=\"primary\">Save selection</button></div></div><div id=\"returnsGrid\" class=\"item-grid\"></div><p id=\"returnsStatus\" class=\"information\"></p></section>\n</main>\n<nav class=\"bottom-nav\" aria-label=\"Sections\"><button data-tab=\"open\" class=\"active\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"9\" cy=\"12\" r=\"6\"/><path d=\"M14 6a6 6 0 1 1 0 12M7 12h4\"/></svg>Coinflips</button><button data-tab=\"returns\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 7h18v13H3zM3 7l3-4h12l3 4M8 11h8M9 15h6\"/></svg>Return items</button><button data-tab=\"history\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 7a9 9 0 1 1-1 7M3 3v5h5M12 7v6l4 2\"/></svg>Recent rounds</button></nav>\n<dialog id=\"pickerDialog\"><div class=\"dialog-top\"><div><h2 id=\"pickerTitle\">Create coinflip</h2><p id=\"pickerSubtitle\">Choose the items you want to wager.</p></div><button class=\"icon-button\" data-close=\"pickerDialog\" aria-label=\"Close wager picker\">×</button></div><div class=\"picker-toolbar\"><span id=\"pickerTotal\" class=\"total\"><span class=\"gem\"></span>0</span><span id=\"pickerCount\" class=\"muted small\">0 items selected</span></div><div id=\"pickerError\" class=\"notice\" hidden></div><div id=\"wagerGrid\" class=\"item-grid\"></div><div class=\"picker-footer\"><p id=\"pickerHint\">Your return items are excluded.</p><button id=\"submitWager\" class=\"primary\">Create coinflip</button></div></dialog>\n<dialog id=\"detailDialog\"><div class=\"detail-header\"><div class=\"brand\"><div class=\"brand-mark\">H</div><div><strong>HEXIUM</strong><span>Flip</span></div></div><button class=\"icon-button\" data-close=\"detailDialog\" aria-label=\"Close round\">×</button></div><div id=\"roundDetail\"></div></dialog>\n<dialog id=\"loginDialog\"><form id=\"loginForm\"><div class=\"dialog-top\"><h2>Connect Hexium</h2><button type=\"button\" class=\"icon-button\" data-close=\"loginDialog\" aria-label=\"Close login\">×</button></div><p class=\"fair-copy\">Use the .ROBLOSECURITY issued by hexium.zip. Connecting authorizes payout trades for rounds you enter.</p><label for=\"cookie\">Hexium cookie value</label><input id=\"cookie\" type=\"password\" autocomplete=\"off\" spellcheck=\"false\" required><p class=\"fair-copy\" style=\"margin-top:12px\">Use a Hexium-issued cookie. Connections expire after 12 hours.</p><button id=\"loginSubmit\" class=\"primary\">Connect</button><p id=\"loginError\" class=\"form-error\" role=\"alert\" hidden></p></form></dialog>\n<dialog id=\"proofDialog\"><div class=\"dialog-top\"><h2>Provably fair</h2><button class=\"icon-button\" data-close=\"proofDialog\" aria-label=\"Close fairness verifier\">×</button></div><p class=\"fair-copy\">The server seed is committed before joining. Both client seeds, accounts, item copies, fixed values and matching-rule version determine the weighted HMAC draw. The verifier checks the published outcome, independently of payout status.</p><label for=\"proofInput\">Round proof JSON</label><textarea id=\"proofInput\" spellcheck=\"false\"></textarea><div class=\"actions\" style=\"justify-content:flex-start;margin-top:14px\"><button id=\"verify\" class=\"primary\">Verify locally</button><button id=\"copyProof\">Copy proof</button></div><p id=\"proofResult\" role=\"status\"></p><pre id=\"proofDetails\" hidden></pre></dialog>\n<div id=\"toast\" hidden role=\"status\"></div>\n<script>\nconst PREVIEW_DATA = null;\nconst $ = id => document.getElementById(id);\nconst number = x => new Intl.NumberFormat(undefined,{maximumFractionDigits:3}).format(x);\nconst safe = x => String(x ?? '').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\nconst hex = b => Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');\nconst seed = () => hex(crypto.getRandomValues(new Uint8Array(32)));\nconst sha = async text => hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));\nlet me=null,inventory=[],games=[],returns=new Set(),savedReturns=new Set(),locked=new Set(),stake=new Set(),tab='open',busy=false,loadingGames=false,loadingInventory=false,pickerTarget=null,detailId=null;\nlet thumbAssets={},thumbUsers={},thumbPending=new Set(),thumbRunning=false;\nconst thumbnailAttempts=new Map(), seenFinals=new Set();\nconst matchingRule=g=>g.matchingRule||'strict-1pct-v1';\nfunction rangeOf(g){const p=matchingRule(g)==='floor-range-3pct-v1'?103n:101n;return {min:Number(BigInt(g.a.total)*100n/(p*1000n)),max:Number(BigInt(g.a.total)*p/100000n)}}\nfunction toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,8500)}\nasync function api(path,body){if(PREVIEW_DATA)return previewAPI(path,body);const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed.');return d}\nasync function action(fn){if(busy)return;busy=true;controls();try{await fn()}catch(e){toast(e.message)}finally{busy=false;controls()}}\nfunction controls(){\n $('connect').hidden=!!me;$('logout').hidden=!me;$('account').textContent=me?me.displayName+' · #'+me.id:'';\n $('create').disabled=busy;$('saveReturns').disabled=busy||!me||returns.size<1||returns.size>3||[...returns].some(x=>locked.has(x));$('refreshReturns').disabled=busy||!me;$('loginSubmit').disabled=busy;\n $('returnCount').textContent=returns.size+' selected · max 3';\n const amount=inventory.filter(i=>stake.has(i.userAssetId)).reduce((s,i)=>s+i.units,0);\n $('pickerTotal').innerHTML='<span class=\"gem\"></span>'+number(amount/1000);$('pickerCount').textContent=stake.size+' '+(stake.size===1?'item':'items')+' selected';\n const target=pickerTarget&&games.find(g=>g.id===pickerTarget);let valid=amount>0;\n if(target){const r=rangeOf(target);valid=valid&&amount>=r.min*1000&&amount<=r.max*1000;$('pickerHint').textContent='Join range: '+number(r.min)+'-'+number(r.max);}\n else $('pickerHint').textContent='Your return items are excluded.';\n $('submitWager').disabled=busy||!valid;\n}\nfunction thumb(kind,id,name,cls=''){const key=String(id),src=(kind==='assets'?thumbAssets:thumbUsers)[key];return '<div class=\"'+(kind==='users'?'avatar':'thumb')+' '+cls+'\"><span class=\"initial\" aria-hidden=\"true\">'+safe(String(name||'?').slice(0,2).toUpperCase())+'</span><img '+(src?'src=\"'+safe(src)+'\"':'hidden')+' data-'+(kind==='users'?'user':'asset')+'=\"'+safe(id)+'\" alt=\"'+safe(name)+'\" loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\"></div>'}\nfunction hydrateThumbs(){\n const all=[...document.querySelectorAll('img[data-asset],img[data-user]')];\n for(const img of all){const kind=img.dataset.asset?'assets':'users',id=img.dataset.asset||img.dataset.user,key=kind+':'+id,url=(kind==='assets'?thumbAssets:thumbUsers)[id];\n  if(url){if(img.getAttribute('src')!==url)img.src=url;img.hidden=false;if(img.complete&&img.naturalWidth)img.parentElement.classList.add('image-ready')}\n  else if(!thumbPending.has(key)&&(!thumbnailAttempts.has(key)||Date.now()-thumbnailAttempts.get(key)>300000))thumbPending.add(key);\n }\n if(thumbRunning||!thumbPending.size)return;thumbRunning=true;\n (async()=>{try{while(thumbPending.size){const available=[...thumbPending],batch=available.filter(x=>x.startsWith('assets:')).slice(0,50).concat(available.filter(x=>x.startsWith('users:')).slice(0,20));batch.forEach(x=>{thumbPending.delete(x);thumbnailAttempts.set(x,Date.now())});const assets=batch.filter(x=>x.startsWith('assets:')).map(x=>x.split(':')[1]),users=batch.filter(x=>x.startsWith('users:')).slice(0,20).map(x=>x.split(':')[1]);const params=new URLSearchParams();if(assets.length)params.set('assetIds',assets.join(','));if(users.length)params.set('userIds',users.join(','));const d=await api('thumbnails?'+params.toString());Object.assign(thumbAssets,d.assets);Object.assign(thumbUsers,d.users);for(const img of document.querySelectorAll('img[data-asset],img[data-user]')){const src=img.dataset.asset?thumbAssets[img.dataset.asset]:thumbUsers[img.dataset.user];if(src){img.src=src;img.hidden=false;if(img.complete&&img.naturalWidth)img.parentElement.classList.add('image-ready')}}}}catch{}finally{thumbRunning=false}})();\n}\ndocument.addEventListener('load',e=>{if(e.target.matches?.('img[data-asset],img[data-user]'))e.target.parentElement.classList.add('image-ready')},true);\ndocument.addEventListener('error',e=>{if(e.target.matches?.('img[data-asset],img[data-user]')){e.target.hidden=true;e.target.parentElement.classList.remove('image-ready')}},true);\nfunction setTab(next){tab=next;document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===next));$('roundsSection').hidden=next==='returns';$('returnsSection').hidden=next!=='returns';$('roundsTitle').textContent=next==='history'?'Recent rounds':'Coinflips';$('create').hidden=next==='history';renderGames();renderReturns();}\nasync function loadInventory(){if(!me||loadingInventory)return;loadingInventory=true;try{const d=await api('inventory');inventory=d.items;locked=new Set(d.locked);const valid=new Set(inventory.map(i=>i.userAssetId));returns=new Set([...returns].filter(x=>valid.has(x)&&inventory.find(i=>i.userAssetId===x).units<150000));stake=new Set([...stake].filter(x=>valid.has(x)&&!locked.has(x)&&!returns.has(x)));renderReturns();if($('pickerDialog').open)renderWagers();controls()}finally{loadingInventory=false}}\nfunction tile(item,selected,disabled,kind){return '<button type=\"button\" class=\"item-tile '+(selected?'selected':'')+'\" data-'+kind+'=\"'+item.userAssetId+'\" aria-pressed=\"'+selected+'\" '+(disabled?'disabled':'')+' aria-label=\"'+safe(item.name)+', value '+number(item.value)+', copy '+item.userAssetId+'\"><span class=\"select-mark\">'+(selected?'✓':'')+'</span>'+(locked.has(item.userAssetId)?'<span class=\"reserved\">Reserved</span>':'')+thumb('assets',item.assetId,item.name)+'<span class=\"tile-copy\"><span class=\"tile-name\">'+safe(item.name)+'</span><span class=\"tile-value\"><span class=\"gem\"></span>'+number(item.value)+'</span><span class=\"tile-id\">Copy #'+item.userAssetId+' · '+safe(item.source)+'</span></span></button>'}\nfunction renderReturns(){const items=inventory.filter(i=>i.units<150000);$('returnsGrid').innerHTML=!me?'<div class=\"empty\"><h2>Connect your account</h2><p>Log in to choose your return items.</p><button class=\"primary\" data-login>Login</button></div>':items.length?items.map(i=>tile(i,returns.has(i.userAssetId),locked.has(i.userAssetId)||(!returns.has(i.userAssetId)&&returns.size>=3),'return')).join(''):'<div class=\"empty\">No items worth under 150 are available.</div>';const changed=[...returns].sort().join(',')!==[...savedReturns].sort().join(',');$('returnsStatus').textContent=[...returns].some(x=>locked.has(x))?'Your selected return items are reserved in an active round.':changed?'Selection changed. Save it before wagering.':returns.size?'Selection saved. These copies are excluded from your wager picker.':'Select at least one return item to start playing.';hydrateThumbs();controls()}\nfunction renderWagers(){const items=inventory.filter(i=>!returns.has(i.userAssetId)&&!locked.has(i.userAssetId)&&i.units>0);$('wagerGrid').innerHTML=items.length?items.map(i=>tile(i,stake.has(i.userAssetId),false,'stake')).join(''):'<div class=\"empty\">No available wager items. Return items and reserved copies are excluded.</div>';hydrateThumbs();controls()}\nfunction coinMarkup(g,spinning,small=false){const back=!spinning&&g.b&&g.winnerId===g.b.id;const elapsed=g.animationUntil?Math.max(0,Date.now()-(g.animationUntil-7000)):0;return '<div class=\"coin-scene '+(small?'mini-coin':'')+'\"><div class=\"coin '+(spinning?'spin':back?'winner-b':'')+'\" style=\"--coin-delay:'+(-((elapsed%700)/1000))+'s\" role=\"img\" aria-label=\"Coin sides: account '+safe(g.a.id)+' and '+(g.b?safe(g.b.id):'waiting player')+'\"><div class=\"coin-face\"><small>ACCOUNT</small><strong>'+safe(g.a.id)+'</strong></div><div class=\"coin-face coin-back\"><small>ACCOUNT</small><strong>'+(g.b?safe(g.b.id):'?')+'</strong></div></div></div>'}\nfunction isSpinning(g){return !!g.b&&Date.now()<g.animationUntil&&g.state!=='cancelled'}\nfunction stateLabel(g){return isSpinning(g)?'Flipping…':g.state==='open'?'Open':g.state==='completed'?((g.winnerId===g.a.id?g.a:g.b)?.displayName+' won'):g.state==='cancelled'?'Cancelled':g.state==='review'?'Payout needs review':'Confirming payout'}\nfunction renderGames(){\n clearTimeout(renderGames.timer);const ending=games.filter(isSpinning).map(g=>g.animationUntil);if(ending.length)renderGames.timer=setTimeout(()=>{renderGames();renderDetail()},Math.max(1,Math.min(...ending)-Date.now()+20));\n const list=games.filter(g=>tab==='history'?!['open','settling','reconciling','review'].includes(g.state):['open','settling','reconciling','review'].includes(g.state));\n $('games').innerHTML=list.length?list.map(g=>{const spinning=isSpinning(g),r=rangeOf(g),items=[...g.a.items,...(g.b?.items||[])],total=g.a.total+(g.b?.total||0);return '<article class=\"round-card\"><span class=\"card-status\">'+safe(stateLabel(g))+'</span><div class=\"card-players\">'+thumb('users',g.a.id,g.a.displayName,g.winnerId===g.a.id&&!spinning?'winner':'')+'<span class=\"versus\">VS</span>'+(g.b?thumb('users',g.b.id,g.b.displayName,g.winnerId===g.b.id&&!spinning?'winner':''):'<div class=\"avatar\"><span class=\"initial\">?</span></div>')+'</div><div class=\"thumb-row\">'+items.slice(0,5).map(i=>thumb('assets',i.assetId,i.name,'small-thumb')).join('')+(items.length>5?'<span class=\"more-items\">+'+(items.length-5)+'</span>':'')+'</div>'+(g.b?coinMarkup(g,spinning,true):'')+'<div class=\"card-value\"><span class=\"gem\"></span>'+number(total/1000)+'</div><div class=\"range\">'+number(r.min)+'-'+number(r.max)+'</div><div class=\"actions\">'+(g.state==='open'&&(!me||me.id!==g.a.id)?'<button class=\"primary\" data-join=\"'+safe(g.id)+'\">Join</button>':'')+'<button data-view=\"'+safe(g.id)+'\">View</button></div></article>'}).join(''):'<div class=\"empty\"><h2>'+(tab==='history'?'No finished rounds':'No open coinflips')+'</h2><p>'+(tab==='history'?'Completed rounds appear here.':'Create a coinflip and choose your wager items.')+'</p>'+(tab==='history'?'':'<button class=\"primary\" data-create>Create coinflip</button>')+'</div>';\n hydrateThumbs();controls();\n}\nfunction detailPlayer(p,winner){if(!p)return '<div class=\"detail-player\"><div class=\"avatar\"><span class=\"initial\">?</span></div><strong class=\"muted\">Waiting for player</strong><small>Join with matching items</small></div>';return '<div class=\"detail-player\">'+thumb('users',p.id,p.displayName,winner?'winner':'')+'<strong>'+safe(p.displayName)+'</strong><small>#'+p.id+'</small></div>'}\nfunction detailItems(p){return p?p.items.map(i=>'<div class=\"stake-item\"><div class=\"row\">'+thumb('assets',i.assetId,i.name)+'<strong><span class=\"gem\"></span>'+number(i.value)+'</strong></div><p>'+safe(i.name)+'</p></div>').join(''):'<div class=\"stake-item muted small\">No wager yet.</div>'}\nfunction renderDetail(){if(!$('detailDialog').open||!detailId)return;const g=games.find(x=>x.id===detailId);if(!g)return;const spin=isSpinning(g),mine=me&&(g.a.id===me.id||g.b?.id===me.id),r=rangeOf(g);$('roundDetail').innerHTML='<div class=\"detail-players\">'+detailPlayer(g.a,!spin&&g.winnerId===g.a.id)+coinMarkup(g,spin)+detailPlayer(g.b,!spin&&g.winnerId===g.b?.id)+'</div><div class=\"detail-state '+(g.state==='completed'?'green':'')+'\">'+safe(stateLabel(g))+'</div><div class=\"round-hash\" title=\"'+safe(g.commitment)+'\"># '+safe(g.commitment)+'</div><div class=\"detail-stats\"><div class=\"detail-stat\"><span class=\"muted\">'+(g.a.odds==null?'—':number(g.a.odds*100)+'%')+'</span><strong><span class=\"gem\"></span>'+number(g.a.total/1000)+'</strong></div><div class=\"detail-stat\"><span class=\"muted\">'+(g.b?.odds==null?'—':number(g.b.odds*100)+'%')+'</span><strong><span class=\"gem\"></span>'+(g.b?number(g.b.total/1000):'—')+'</strong></div></div><div class=\"stake-columns\"><div>'+detailItems(g.a)+'</div><div>'+detailItems(g.b)+'</div></div>'+(g.state==='open'?'<p class=\"information\" style=\"text-align:center\">Join range: '+number(r.min)+'-'+number(r.max)+'</p>':'')+(g.error?'<div class=\"notice detail-error\">'+safe(g.error)+'</div>':'')+'<div class=\"actions detail-actions\">'+(g.state==='open'?(me&&g.a.id===me.id?'<button data-cancel=\"'+safe(g.id)+'\">Cancel coinflip</button>':'<button class=\"primary\" data-join=\"'+safe(g.id)+'\">Join coinflip</button>'):'')+'<button data-proof=\"'+safe(g.id)+'\">'+(g.proof?'Verify round':'View commitment')+'</button>'+(mine&&['review','reconciling'].includes(g.state)?'<button data-reconcile=\"'+safe(g.id)+'\">Recheck payout</button>':'')+'</div>';hydrateThumbs()}\nfunction showGame(id){detailId=id;if(!$('detailDialog').open)$('detailDialog').showModal();renderDetail()}\nasync function refreshGames(){if(loadingGames)return;loadingGames=true;try{const d=await api('games');games=d.games;$('globalError').hidden=true;renderGames();renderDetail();let update=false;for(const g of games)if(me&&(g.a.id===me.id||g.b?.id===me.id)&&['completed','cancelled'].includes(g.state)&&!seenFinals.has(g.id)){seenFinals.add(g.id);update=true}if(update)await loadInventory()}catch(e){$('globalError').textContent=e.message;$('globalError').hidden=false}finally{loadingGames=false}}\nasync function saveReturns(){await api('returns',{ids:[...returns]});savedReturns=new Set(returns);renderReturns()}\nasync function openWager(gameId=null){\n if(!me){$('connect').click();return}\n await loadInventory();if(!returns.size){setTab('returns');throw Error('Select and save a return item first.')}\n if([...returns].some(x=>locked.has(x)))throw Error('Your return items are reserved in another active round.');\n if($('detailDialog').open)$('detailDialog').close();pickerTarget=gameId;stake.clear();$('pickerTitle').textContent=gameId?'Join coinflip':'Create coinflip';$('pickerSubtitle').textContent=gameId?'Choose your wager within the displayed range.':'Choose the item copies you want to wager.';$('submitWager').textContent=gameId?'Join coinflip':'Create coinflip';$('pickerError').hidden=true;renderWagers();$('pickerDialog').showModal();\n}\n$('create').onclick=()=>action(()=>openWager());$('connect').onclick=()=>PREVIEW_DATA?action(async()=>{const d=await api('login',{});me=d.user;const p=await api('me');returns=new Set(p.returnIds);savedReturns=new Set(returns);await loadInventory();controls()}):$('loginDialog').showModal();\n$('logout').onclick=()=>action(async()=>{await api('logout',{});me=null;inventory=[];returns.clear();savedReturns.clear();stake.clear();locked.clear();setTab('open');controls();toast('Disconnected.');await refreshGames()});\n$('refreshReturns').onclick=()=>action(loadInventory);$('saveReturns').onclick=()=>action(async()=>{await saveReturns();toast('Return items saved.')});\n$('returnsGrid').onclick=e=>{const b=e.target.closest('[data-return]');if(!b||busy)return;const id=Number(b.dataset.return);if(returns.has(id))returns.delete(id);else if(returns.size<3)returns.add(id);renderReturns()};\n$('wagerGrid').onclick=e=>{const b=e.target.closest('[data-stake]');if(!b||busy)return;const id=Number(b.dataset.stake);stake.has(id)?stake.delete(id):stake.add(id);renderWagers()};\n$('submitWager').onclick=()=>action(async()=>{try{await saveReturns();let g;if(pickerTarget){const target=games.find(x=>x.id===pickerTarget);if(!target||target.state!=='open')throw Error('This round is no longer open.');g=await api('join',{gameId:target.id,ids:[...stake],commitment:target.commitment,clientSeed:seed()})}else g=await api('create',{ids:[...stake],clientSeed:seed()});$('pickerDialog').close();stake.clear();setTab('open');await refreshGames();showGame(g.id);await loadInventory()}catch(e){$('pickerError').textContent=e.message;$('pickerError').hidden=false;throw e}});\n$('loginForm').onsubmit=e=>{e.preventDefault();action(async()=>{try{const value=$('cookie').value.trim();$('cookie').value='';const d=await api('login',{cookie:value});me=d.user;const profile=await api('me');returns=new Set(profile.returnIds);savedReturns=new Set(returns);$('loginError').hidden=true;$('loginDialog').close();await loadInventory();setTab(returns.size?'open':'returns');await refreshGames()}catch(e){$('loginError').textContent=e.message;$('loginError').hidden=false;throw e}})};\ndocument.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.close)$(b.dataset.close).close();if(b.dataset.tab){setTab(b.dataset.tab);if(b.dataset.tab==='returns'&&me)action(loadInventory)}if(b.hasAttribute('data-create'))action(()=>openWager());if(b.hasAttribute('data-login'))$('connect').click();if(b.dataset.view)showGame(b.dataset.view);if(b.dataset.join)action(()=>openWager(b.dataset.join));if(b.dataset.cancel)action(async()=>{await api('cancel',{gameId:b.dataset.cancel});await refreshGames();await loadInventory()});if(b.dataset.reconcile)action(async()=>{await api('reconcile',{gameId:b.dataset.reconcile});await refreshGames();await loadInventory()});if(b.dataset.proof){const g=games.find(x=>x.id===b.dataset.proof);$('proofInput').value=JSON.stringify(g,null,2);$('proofResult').textContent=g.proof?'Ready to verify.':'The server seed is revealed after another player joins.';$('proofDetails').hidden=true;$('proofDialog').showModal()}});\n$('copyProof').onclick=()=>action(async()=>{try{await navigator.clipboard.writeText($('proofInput').value);toast('Proof copied.')}catch{$('proofInput').focus();$('proofInput').select();toast('Proof selected. Use Copy to save it.')}});\n$('verify').onclick=async()=>{try{const g=JSON.parse($('proofInput').value);if(!g.proof)throw Error('This game has not revealed a result yet.');const p=g.proof,E=new TextEncoder(),hx=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');const commit=hx(await crypto.subtle.digest('SHA-256',E.encode(p.serverSeed)));if(commit!==g.commitment)throw Error('Server seed does not match its commitment.');const a=g.a.items.reduce((s,x)=>s+x.units,0),b=g.b.items.reduce((s,x)=>s+x.units,0);if(a!==g.a.total||b!==g.b.total||a+b!==p.total||a!==p.threshold)throw Error('Stake totals do not match item valuations.');const rounded=['floor-range-v1','floor-range-3pct-v1'].includes(g.matchingRule),factor=g.matchingRule==='floor-range-3pct-v1'?103n:101n;if(g.matchingRule&& !['floor-range-v1','floor-range-3pct-v1','strict-1pct-v1'].includes(g.matchingRule))throw Error('Unknown matching rule.');if(Math.min(a,b)<=0)throw Error('Stake totals must be positive.');if(rounded){const low=Number(BigInt(a)*100n/(factor*1000n))*1000,high=Number(BigInt(a)*factor/100000n)*1000;if(b<low||b>high)throw Error('Stakes violate the displayed rounded join range.')}else if(BigInt(Math.max(a,b))*100n>BigInt(Math.min(a,b))*101n)throw Error('Stakes violate the legacy 1% rule.');const message=JSON.stringify([g.matchingRule==='floor-range-3pct-v1'?'hexium-flip-v3-floor-range-3pct':rounded?'hexium-flip-v2-floor-range':'hexium-flip-v1',g.id,g.nonce,g.a.id,g.b.id,g.clientA,g.clientB,a,b,g.a.items.map(x=>x.userAssetId),g.b.items.map(x=>x.userAssetId)]);if(message!==p.message)throw Error('Round data does not match the signed message.');const key=await crypto.subtle.importKey('raw',E.encode(p.serverSeed),{name:'HMAC',hash:'SHA-256'},false,['sign']);const n=BigInt(p.total),space=1n<<256n,limit=space-space%n;let counter=0,digest,ticket;for(;;counter++){digest=hx(await crypto.subtle.sign('HMAC',key,E.encode(message+':'+counter)));const x=BigInt('0x'+digest);if(x<limit){ticket=Number(x%n);break}if(counter>1000)throw Error('Invalid draw.')}const winner=ticket<a?g.a.id:g.b.id;if(ticket!==p.ticket||digest!==p.digest||counter!==p.counter||winner!==p.winnerId||winner!==g.winnerId)throw Error('The published outcome does not match the draw.');$('proofResult').textContent='Verified: commitment, item totals, matching rule, draw and winner agree.';$('proofResult').className='gold';$('proofDetails').textContent='SHA-256 commitment: '+commit+'\\nHMAC digest: '+digest+'\\nTicket: '+ticket+' / '+p.total+'\\nPlayer A threshold: '+a+'\\nWinning account: '+winner+'\\nPayout state: '+g.state;$('proofDetails').hidden=false}catch(e){$('proofResult').textContent='Verification failed: '+e.message;$('proofResult').className='error'}};\nasync function demoDraw(g){const server=g.demoServerSeed||seed(),E=new TextEncoder();g.commitment=await sha(server);g.nonce=0;g.matchingRule='floor-range-3pct-v1';g.a.odds=g.a.total/(g.a.total+g.b.total);g.b.odds=1-g.a.odds;const message=JSON.stringify(['hexium-flip-v3-floor-range-3pct',g.id,0,g.a.id,g.b.id,g.clientA,g.clientB,g.a.total,g.b.total,g.a.items.map(i=>i.userAssetId),g.b.items.map(i=>i.userAssetId)]);const key=await crypto.subtle.importKey('raw',E.encode(server),{name:'HMAC',hash:'SHA-256'},false,['sign']);const n=BigInt(g.a.total+g.b.total),space=1n<<256n,limit=space-space%n;let counter=0,digest,ticket;for(;;counter++){digest=hex(await crypto.subtle.sign('HMAC',key,E.encode(message+':'+counter)));const x=BigInt('0x'+digest);if(x<limit){ticket=Number(x%n);break}}g.winnerId=ticket<g.a.total?g.a.id:g.b.id;g.proof={serverSeed:server,message,counter,digest,ticket,total:g.a.total+g.b.total,threshold:g.a.total,winnerId:g.winnerId};g.state='settling';g.animationUntil=Date.now()+7000;setTimeout(()=>{g.state='completed';refreshGames()},7100)}\nasync function previewAPI(path,body){\n const base=path.split('?')[0],data=PREVIEW_DATA;\n if(base==='me'){if(!data.connected)throw Error('Connect the demo account to continue.');return {user:data.user,returnIds:data.returnIds}}\n if(base==='login'){data.connected=true;return {user:data.user}}\n if(base==='logout'){data.connected=false;return {ok:true}}\n if(base==='inventory'){const ids=new Set();for(const g of data.games)if(['open','settling','reconciling','review'].includes(g.state)&&(g.a.id===data.user.id||g.b?.id===data.user.id)){const p=g.a.id===data.user.id?g.a:g.b;p.items.forEach(i=>ids.add(i.userAssetId));data.returnIds.forEach(i=>ids.add(i))}return {items:data.items,locked:[...ids],valueTime:Date.now()}}\n if(base==='games')return {games:data.games};\n if(base==='thumbnails')return {assets:data.assets,users:data.users};\n if(base==='returns'){if(body.ids.length<1||body.ids.length>3)throw Error('Select one to three return items.');data.returnIds=body.ids;return {ok:true}}\n if(base==='cancel'){const g=data.games.find(x=>x.id===body.gameId);g.state='cancelled';g.error='Cancelled by creator.';return {ok:true}}\n if(base==='reconcile')return data.games.find(x=>x.id===body.gameId);\n if(base==='create'||base==='join'){\n  if(data.games.some(g=>['open','settling','reconciling','review'].includes(g.state)&&(g.a.id===data.user.id||g.b?.id===data.user.id)))throw Error('Finish or cancel your current demo round first.');\n  const items=body.ids.map(id=>data.items.find(i=>i.userAssetId===id));if(!items.length||items.some(i=>!i||data.returnIds.includes(i.userAssetId)))throw Error('Select available wager items.');\n  const p={...data.user,items,total:items.reduce((s,i)=>s+i.units,0),odds:null};let g;\n  if(base==='create'){const server=seed();g={demoServerSeed:server,id:crypto.randomUUID(),state:'open',a:p,b:null,created:Date.now(),expires:Date.now()+900000,matchingRule:'floor-range-3pct-v1',commitment:await sha(server),clientA:body.clientSeed,clientB:null,nonce:0,proof:null};data.games.unshift(g);setTimeout(async()=>{if(g.state!=='open')return;g.b={id:7718,name:'fursuit',displayName:'fursuit',items:items.map(i=>({...i,userAssetId:i.userAssetId+900000})),total:p.total,odds:null};g.clientB=seed();await demoDraw(g);refreshGames()},1800)}\n  else{g=data.games.find(x=>x.id===body.gameId);if(!g||g.state!=='open')throw Error('This demo round is no longer open.');const r=rangeOf(g);if(p.total<r.min*1000||p.total>r.max*1000)throw Error('Choose a wager in the displayed range.');g.b=p;g.clientB=body.clientSeed;await demoDraw(g)}\n  return g;\n }\n throw Error('Unknown preview action.');\n}\n(async()=>{if(PREVIEW_DATA){$('previewNote').classList.add('visible');Object.assign(thumbAssets,PREVIEW_DATA.assets);Object.assign(thumbUsers,PREVIEW_DATA.users)}try{const d=await api('me');me=d.user;returns=new Set(d.returnIds);savedReturns=new Set(returns);await loadInventory()}catch{}setTab('open');controls();await refreshGames()})();\nsetInterval(()=>{if(!document.hidden)refreshGames()},3000);setInterval(()=>{if(me&&!document.hidden&&!busy&&!$('pickerDialog').open)loadInventory().catch(e=>toast(e.message))},30000);\n</script></body></html>\n";
