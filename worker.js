// Hexium Flip — Cloudflare Module Worker + SQLite Durable Object.
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
  return JSON.stringify(['hexium-flip-v1', g.id, g.nonce, g.a.id, g.b.id,
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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    };
    try {
      if (url.pathname === '/' && request.method === 'GET') return new Response(HTML, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
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
    let response;
    try {
      response = await fetch(HEX + path, {
        method, headers: { Accept: 'application/json', Cookie: `.ROBLOSECURITY=${cookie}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
        cache: 'no-store', signal: AbortSignal.timeout(10000)
      });
    } catch { throw new UpstreamError('Hexium request timed out or could not connect.', method === 'POST'); }
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
      const ambiguous = r.status >= 500 || r.status === 408;
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
    if (this.valuesCache && Date.now() - this.valuesCache.time < 60000) return this.valuesCache;
    let r;
    try { r = await fetch(VALUES, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new UpstreamError('Heximons values are unavailable. Try again shortly.'); }
    if (!r.ok) throw new UpstreamError('Heximons values are unavailable.');
    const data = await r.json();
    if (!data.assets || typeof data.assets !== 'object' || Array.isArray(data.assets)) throw new UpstreamError('Unexpected Heximons value format.');
    return this.valuesCache = { data, time: Date.now() };
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
      must(byId.get(x).units > 0, 'Stake items must have a positive value.');
      return byId.get(x);
    });
    must(Array.isArray(user.returnIds) && user.returnIds.length >= 3, 'Choose at least three small return items first.');
    const returnIds = user.returnIds.filter(x => byId.has(x) && byId.get(x).units < 150000 && !selected.includes(x) && !locked.has(x));
    must(returnIds.length >= 3, 'At least three selected return items must still be owned, worth under 150, and available.');
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
      nonce: g.nonce, valueTime: g.valueTime, winnerId: g.winnerId || null, error: g.error || null,
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
      must(Array.isArray(body.ids) && body.ids.length >= 3 && body.ids.length <= 50 && body.ids.every(Number.isSafeInteger) && new Set(body.ids).size === body.ids.length, 'Select at least three different item copies.');
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
      const g = { id: gameId, state: 'open', a, b: null, seed, commitment: await hash(seed), clientA: body.clientSeed, nonce: 0, created: Date.now(), expires: Date.now() + OPEN_MS, valueTime: snapshot.time, values: snapshot.data };
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
      must(stakeMatch(g.a.total, b.total), 'Stake totals must be within 1%.');
      must(Number.isSafeInteger(g.a.total + b.total), 'Combined stake is too large.');
      // Return items are always checked using current values, not frozen stake overrides.
      const winnerReturns = this.valued(makerInv, snapshot.data).filter(i => g.a.returnIds.includes(i.userAssetId) && i.units < 150000);
      must(winnerReturns.length >= 3, 'Creator needs three available small return items.');
      const bCurrent = this.valued(await this.inventory(id), snapshot.data);
      must(b.returnIds.filter(x => bCurrent.some(i => i.userAssetId === x && i.units < 150000)).length >= 3, 'You need three available small return items.');
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

const HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101219"><title>Hexium Flip</title>
<style>
:root{color-scheme:dark;--bg:#101219;--panel:#191d28;--line:#2d3342;--muted:#adb4c6;--gold:#f5c96b;--blue:#91baff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#f6f7fb;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}button,input,textarea{font:inherit}button{cursor:pointer;min-height:44px;padding:10px 18px;border:1px solid var(--line);border-radius:9px;background:#242a38;color:inherit;font-weight:600}button:hover{border-color:var(--gold)}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:var(--gold);color:#201a0f;border-color:var(--gold)}input,textarea{width:100%;background:#10141d;color:inherit;border:1px solid var(--line);border-radius:8px;padding:12px}textarea{min-height:100px}header{padding:20px max(22px,calc((100vw - 1280px)/2));border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:16px}header strong{letter-spacing:-1px;font-size:24px}header strong span{color:var(--gold)}header nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap}main{max-width:1280px;margin:auto;padding:26px 22px}h1,h2,h3,p{margin-top:0}h1{font-size:30px;letter-spacing:-1px}h2{font-size:21px}h3{font-size:17px}.muted,small{color:var(--muted)}small{font-size:14px}.layout{display:grid;grid-template-columns:minmax(280px,370px) 1fr;gap:24px}.panel{background:var(--panel);border:1px solid var(--line);padding:22px;border-radius:14px;margin-bottom:20px}.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.badge{font-size:14px;border:1px solid var(--line);padding:3px 9px;border-radius:6px;color:var(--muted)}.gold{color:var(--gold)}.error{color:#ffb2ac}.notice{background:#302725;border:1px solid #6b4840;border-radius:9px;padding:12px;margin-bottom:18px}.items{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;max-height:410px;overflow:auto;padding:2px}.item{background:#11151e;border:1px solid var(--line);padding:12px;border-radius:9px;display:flex;flex-direction:column;gap:8px}.item label{display:flex;gap:8px;align-items:flex-start;font-size:14px}.item input{width:18px;height:18px;margin-top:3px;accent-color:var(--gold)}.item.selected{border-color:var(--gold)}.item strong{font-size:15px}.mini{font-size:14px}.games{display:grid;gap:16px}.game{background:var(--panel);border:1px solid var(--line);padding:20px;border-radius:14px}.versus{display:grid;grid-template-columns:1fr 70px 1fr;align-items:center;gap:14px;margin:18px 0}.versus .side{min-width:0}.side strong{display:block}.side p{font-size:14px;color:var(--muted);overflow-wrap:anywhere;margin:6px 0}.coin{width:60px;height:60px;display:grid;place-items:center;background:var(--gold);color:#251d0e;font-size:25px;font-weight:800;border-radius:50%;border:4px solid #ad803a;box-shadow:0 0 0 4px #f5c96b18}.spin{animation:flip .7s linear infinite}@keyframes flip{to{transform:rotateY(360deg)}}.empty{padding:40px 20px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:14px}.bar{height:6px;background:var(--blue);border-radius:4px;overflow:hidden;margin-top:12px}.bar div{height:100%;background:var(--gold)}dialog{color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:16px;width:min(760px,calc(100% - 32px));max-height:90vh;padding:24px}dialog::backdrop{background:#000b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#10141d;border-radius:8px;padding:14px;font:13px/1.6 ui-monospace,monospace}#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);max-width:calc(100% - 32px);background:#303747;border:1px solid #66718a;border-radius:10px;padding:12px 18px;z-index:10}#cookie{margin:12px 0}a{color:var(--blue)}[hidden]{display:none!important}.tabs{display:flex;gap:10px;margin-bottom:20px}.tab-active{border-color:var(--gold);color:var(--gold)}@media(max-width:850px){.layout{grid-template-columns:1fr}header{padding:16px 20px}header nav{justify-content:flex-end}main{padding:20px 16px}.versus{grid-template-columns:1fr 50px 1fr;gap:10px}.coin{width:44px;height:44px;font-size:20px;border-width:3px}.panel,.game{padding:18px}}@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style></head><body>
<header><strong>HEXIUM <span>FLIP</span></strong><nav><span id="account" class="mini muted">Not connected</span><button id="fairness">Provably fair</button><button id="connect" class="primary">Connect Hexium</button><button id="logout" hidden>Disconnect</button></nav></header>
<main><div class="row" style="margin-bottom:20px"><h1 style="margin:0">Coinflips</h1><span class="badge">1% matching range</span></div><div id="globalError" class="notice" hidden></div>
<div class="layout"><aside><section class="panel"><h2>Your stake</h2><p class="muted mini">Choose item copies from your inventory. Keep at least three items worth under 150 selected for returns.</p><div class="row"><span class="muted">Selected value</span><strong id="stakeTotal" class="gold">0</strong></div><div class="row" style="margin-top:8px"><span class="muted">Return items</span><strong id="returnCount">0 / 3</strong></div><div class="actions"><button id="refresh">Refresh inventory</button><button id="saveReturns">Save return items</button></div><div class="actions"><button id="create" class="primary" style="width:100%">Create coinflip</button></div><p id="inventoryStatus" class="muted mini" style="margin-top:16px;margin-bottom:0">Connect to load your items.</p></section><section class="panel"><h3>How payouts work</h3><p class="muted mini" style="margin:0">The loser sends their stake. The winner returns one selected small item, choosing the lowest current value. Selected items are reserved while a game is active.</p></section></aside>
<section><div class="tabs"><button id="tabOpen" class="tab-active">Open games</button><button id="tabHistory">Recent rounds</button><button id="tabInventory">Inventory</button></div><div id="games" class="games"></div><div id="inventoryPanel" hidden><div class="row" style="margin-bottom:14px"><h2 style="margin:0">Your inventory</h2><span id="priceAge" class="mini muted"></span></div><div id="items" class="items"></div></div></section></div></main>
<dialog id="loginDialog"><form id="loginForm"><div class="row"><h2 style="margin:0">Connect your Hexium account</h2><button type="button" data-close="loginDialog">Close</button></div><p class="muted" style="margin-top:16px">Use the .ROBLOSECURITY issued by hexium.zip. This connection authorizes the site to send and accept payout trades for games you enter.</p><label for="cookie">Hexium cookie value</label><input id="cookie" type="password" autocomplete="off" spellcheck="false" required><p class="muted mini">Do not enter a Roblox-issued cookie. Connections expire after 12 hours.</p><button class="primary" id="loginSubmit">Connect and load inventory</button></form></dialog>
<dialog id="proofDialog"><div class="row"><h2 style="margin:0">Provably fair</h2><button data-close="proofDialog">Close</button></div><p class="muted" style="margin-top:16px">Each open game publishes SHA-256(server seed). The joiner contributes a fresh client seed after that commitment. HMAC-SHA-256 combines both seeds, accounts, item copies and fixed stake values to produce a weighted draw.</p><p class="muted mini">A rejection-sampled integer ticket chooses player A when ticket &lt; A's value in thousandths. Failed payouts retain the original draw and proof. Verification checks the draw; it does not guarantee payment or independently prove when the commitment was published.</p><label for="proofInput">Round proof JSON</label><textarea id="proofInput" spellcheck="false" placeholder="Choose Verify on a round, or paste an exported round here."></textarea><div class="actions"><button id="verify" class="primary">Verify locally</button><button id="copyProof">Copy proof</button></div><p id="proofResult" role="status"></p><pre id="proofDetails" hidden></pre></dialog>
<div id="toast" hidden role="status"></div>
<script>
const $=id=>document.getElementById(id), number=x=>new Intl.NumberFormat(undefined,{maximumFractionDigits:3}).format(x), safe=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me=null,inventory=[],games=[],stake=new Set(),returns=new Set(),locked=new Set(),tab='open',busy=false,loading=false;
const seenRounds=new Set();
function seed(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('')}
async function api(path,body){const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,7000)}
async function action(fn){if(busy)return;busy=true;controls();try{await fn()}catch(e){toast(e.message)}finally{busy=false;controls()}}
function controls(){for(const id of ['create','saveReturns','refresh'])$(id).disabled=busy||!me;$('loginSubmit').disabled=busy; $('connect').hidden=!!me;$('logout').hidden=!me;$('account').textContent=me?me.displayName+' · #'+me.id:'Not connected';$('stakeTotal').textContent=number(inventory.filter(i=>stake.has(i.userAssetId)).reduce((s,i)=>s+i.value,0));$('returnCount').textContent=returns.size+' / 3';}
function setTab(t){tab=t;['Open','History','Inventory'].forEach(x=>$('tab'+x).classList.toggle('tab-active',x.toLowerCase()===t));$('inventoryPanel').hidden=t!=='inventory';$('games').hidden=t==='inventory';renderGames();}
async function loadInventory(){if(!me)return;const d=await api('inventory');inventory=d.items;locked=new Set(d.locked);const ids=new Set(inventory.map(i=>i.userAssetId));stake=new Set([...stake].filter(x=>ids.has(x)&&!locked.has(x)));returns=new Set([...returns].filter(x=>ids.has(x)));$('priceAge').textContent='Values '+new Date(d.valueTime).toLocaleTimeString();$('inventoryStatus').textContent=inventory.length+' item copies · '+locked.size+' reserved';renderItems();controls();}
function renderItems(){$('items').innerHTML=inventory.length?inventory.map(i=>{const id=i.userAssetId,lock=locked.has(id);return '<div class="item '+(stake.has(id)?'selected':'')+'"><strong>'+safe(i.name)+'</strong><span class="gold">'+number(i.value)+' <small>'+safe(i.source)+'</small></span><small>Copy #'+id+(i.serialNumber!=null?' · Serial '+safe(i.serialNumber):'')+'</small><label><input type="checkbox" data-stake="'+id+'" '+(stake.has(id)?'checked':'')+' '+(lock||returns.has(id)?'disabled':'')+'>Stake</label>'+(i.units<150000?'<label><input type="checkbox" data-return="'+id+'" '+(returns.has(id)?'checked':'')+' '+(lock||stake.has(id)?'disabled':'')+'>Small return item</label>':'')+(lock?'<small>Reserved in active game</small>':'')+'</div>'}).join(''):'<div class="empty">No items loaded.</div>';}
function side(p){if(!p)return '<div class="side"><strong class="muted">Waiting for player</strong><p>Choose a stake within 1% to join.</p></div>';return '<div class="side"><strong>'+safe(p.displayName)+'</strong><p>'+p.items.map(i=>safe(i.name)).join(' + ')+'</p><strong class="gold">'+number(p.total/1000)+'</strong>'+(p.odds!==null?'<small>'+number(p.odds*100)+'% chance</small>':'')+'</div>'}
function renderGames(){const filtered=games.filter(g=>tab==='history'?g.state!=='open':g.state==='open'||['settling','reconciling','review'].includes(g.state));$('games').innerHTML=filtered.length?filtered.map(g=>{const mine=me&&(g.a.id===me.id||g.b?.id===me.id),spinning=g.b&&Date.now()<g.animationUntil&&g.state!=='cancelled';const status=spinning?'Flipping…':g.state==='completed'?((g.winnerId===g.a.id?g.a:g.b).displayName+' won'):g.state==='open'?'Open':g.state==='cancelled'?'Cancelled':g.state==='review'?'Payout needs review':'Confirming payout';return '<article class="game"><div class="row"><span class="badge">'+safe(status)+'</span><small>'+new Date(g.created).toLocaleTimeString()+'</small></div><div class="versus">'+side(g.a)+'<div class="coin '+(spinning?'spin':'')+'">H</div>'+side(g.b)+'</div>'+(g.b?'<div class="bar"><div style="width:'+(g.a.odds*100)+'%"></div></div>':'<small>Join range: '+number(g.a.total/1000/1.01)+' – '+number(g.a.total/1000*1.01)+'</small>')+(g.error?'<p class="error mini" style="margin-top:12px">'+safe(g.error)+'</p>':'')+'<div class="actions">'+(g.state==='open'?(me&&g.a.id===me.id?'<button data-cancel="'+safe(g.id)+'">Cancel game</button>':'<button class="primary" data-join="'+safe(g.id)+'">Join with selected stake</button>'):'')+'<button data-proof="'+safe(g.id)+'">'+(g.proof?'Verify round':'View commitment')+'</button>'+(mine&&['review','reconciling'].includes(g.state)?'<button data-reconcile="'+safe(g.id)+'">Recheck payout</button>':'')+'</div></article>'}).join(''):'<div class="empty">'+(tab==='history'?'No rounds yet.':'No open games. Select your items and create the first coinflip.')+'</div>';}
async function refreshGames(){if(loading)return;loading=true;try{const d=await api('games');games=d.games;$('globalError').hidden=true;renderGames();let update=false;for(const g of games)if(me&&(g.a.id===me.id||g.b?.id===me.id)&&['completed','cancelled'].includes(g.state)&&!seenRounds.has(g.id)){seenRounds.add(g.id);update=true}if(update)await loadInventory()}catch(e){$('globalError').textContent=e.message;$('globalError').hidden=false}finally{loading=false}}
$('connect').onclick=()=>$('loginDialog').showModal();$('fairness').onclick=()=>$('proofDialog').showModal();document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('loginForm').onsubmit=e=>{e.preventDefault();action(async()=>{const value=$('cookie').value.trim();$('cookie').value='';const d=await api('login',{cookie:value});me=d.user;const profile=await api('me');returns=new Set(profile.returnIds);$('loginDialog').close();await loadInventory();setTab('inventory');toast('Connected. Select and save at least three small return items.');await refreshGames()})};
$('logout').onclick=()=>action(async()=>{await api('logout',{});me=null;inventory=[];stake.clear();returns.clear();locked.clear();renderItems();controls();toast('Disconnected.');await refreshGames()});
$('refresh').onclick=()=>action(loadInventory);$('saveReturns').onclick=()=>action(async()=>{await api('returns',{ids:[...returns]});toast('Return items saved.');await loadInventory()});
$('create').onclick=()=>action(async()=>{if(stake.size===0){setTab('inventory');throw Error('Select stake items first.')}await api('returns',{ids:[...returns]});await api('create',{ids:[...stake],clientSeed:seed()});stake.clear();await loadInventory();setTab('open');await refreshGames()});
$('items').onchange=e=>{const s=e.target.dataset.stake,r=e.target.dataset.return;if(s){e.target.checked?stake.add(Number(s)):stake.delete(Number(s))}if(r){e.target.checked?returns.add(Number(r)):returns.delete(Number(r))}renderItems();controls()};
$('tabOpen').onclick=()=>setTab('open');$('tabHistory').onclick=()=>setTab('history');$('tabInventory').onclick=()=>setTab('inventory');
$('games').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.proof){const g=games.find(x=>x.id===b.dataset.proof);$('proofInput').value=JSON.stringify(g,null,2);$('proofResult').textContent=g.proof?'Ready to verify.':'Server seed is revealed when another player joins.';$('proofDetails').hidden=true;$('proofDialog').showModal();return}if(!me){$('loginDialog').showModal();return}if(b.dataset.join)action(async()=>{if(!stake.size){setTab('inventory');throw Error('Select your stake items in Inventory, then join.')}const g=games.find(x=>x.id===b.dataset.join);await api('returns',{ids:[...returns]});await api('join',{gameId:g.id,ids:[...stake],commitment:g.commitment,clientSeed:seed()});stake.clear();await refreshGames();await loadInventory();setTab('open')});if(b.dataset.cancel)action(async()=>{await api('cancel',{gameId:b.dataset.cancel});await refreshGames();await loadInventory()});if(b.dataset.reconcile)action(async()=>{await api('reconcile',{gameId:b.dataset.reconcile});await refreshGames();await loadInventory()})};
$('copyProof').onclick=()=>action(async()=>{await navigator.clipboard.writeText($('proofInput').value);toast('Proof copied.')});
$('verify').onclick=async()=>{try{const g=JSON.parse($('proofInput').value);if(!g.proof)throw Error('This game has not revealed a result yet.');const p=g.proof,E=new TextEncoder(),hx=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');const commit=hx(await crypto.subtle.digest('SHA-256',E.encode(p.serverSeed)));if(commit!==g.commitment)throw Error('Server seed does not match its commitment.');const a=g.a.items.reduce((s,x)=>s+x.units,0),b=g.b.items.reduce((s,x)=>s+x.units,0);if(a!==g.a.total||b!==g.b.total||a+b!==p.total||a!==p.threshold)throw Error('Stake totals do not match item valuations.');if(BigInt(Math.max(a,b))*100n>BigInt(Math.min(a,b))*101n||Math.min(a,b)<=0)throw Error('Stakes violate the 1% rule.');const message=JSON.stringify(['hexium-flip-v1',g.id,g.nonce,g.a.id,g.b.id,g.clientA,g.clientB,a,b,g.a.items.map(x=>x.userAssetId),g.b.items.map(x=>x.userAssetId)]);if(message!==p.message)throw Error('Round data does not match the signed message.');const key=await crypto.subtle.importKey('raw',E.encode(p.serverSeed),{name:'HMAC',hash:'SHA-256'},false,['sign']);const n=BigInt(p.total),space=1n<<256n,limit=space-space%n;let counter=0,digest,ticket;for(;;counter++){digest=hx(await crypto.subtle.sign('HMAC',key,E.encode(message+':'+counter)));const x=BigInt('0x'+digest);if(x<limit){ticket=Number(x%n);break}if(counter>1000)throw Error('Invalid draw.')}const winner=ticket<a?g.a.id:g.b.id;if(ticket!==p.ticket||digest!==p.digest||counter!==p.counter||winner!==p.winnerId||winner!==g.winnerId)throw Error('The published outcome does not match the draw.');$('proofResult').textContent='Verified: commitment, item totals, matching rule, draw and winner agree.';$('proofResult').className='gold';$('proofDetails').textContent='SHA-256 commitment: '+commit+'\nHMAC digest: '+digest+'\nTicket: '+ticket+' / '+p.total+'\nPlayer A threshold: '+a+'\nWinning account: '+winner+'\nPayout state: '+g.state;$('proofDetails').hidden=false}catch(e){$('proofResult').textContent='Verification failed: '+e.message;$('proofResult').className='error'}};
(async()=>{try{const d=await api('me');me=d.user;returns=new Set(d.returnIds);await loadInventory()}catch{}controls();await refreshGames()})();setInterval(()=>{if(!document.hidden)refreshGames()},3000);setInterval(()=>{if(me&&!document.hidden&&!busy)action(loadInventory)},30000);
</script></body></html>`;
