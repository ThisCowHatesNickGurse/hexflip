import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { FlipLobby, effectiveValue, stakeMatch, exactTrade, draw, proofMessage } from './worker.js';

const key = '12'.repeat(32);
function rig({ sendTimeout = false, acceptTimeout = false, acceptReject = false, sendReject = false, badTrade = false, csrf = false, readFailure = false, multiStake = false } = {}) {
  const db = new DatabaseSync(':memory:');
  const ctx = { storage: { sql: { exec(sql, ...args) { const stmt = db.prepare(sql); return stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []); } }, async setAlarm() {} }, pending: [], waitUntil(p) { this.pending.push(p); } };
  const makeItem = (id, assetId, price) => ({ userAssetId: id, assetId, recentAveragePrice: price, name: 'Item '+id, serialNumber: null });
  const inventories = new Map([[1,[makeItem(11,101,7000),makeItem(12,102,20),makeItem(13,103,30),makeItem(14,104,40)]], [2,[makeItem(21,101,7000),makeItem(22,102,20),makeItem(23,103,30),makeItem(24,104,40)]]]);
  const values = {assets: {'101':['Horns',null,7000,8000],'102':['Small',null,20,0],'103':['Small',null,30,0],'104':['Small',null,40,0]}};
  if (multiStake) { inventories.get(1).push(makeItem(15,101,7000)); inventories.get(2)[0]=makeItem(21,201,16001); values.assets['201']=['Harmonica',null,16001,16001]; }
  let trade = null, sent = 0, accepted = 0, challenged = false;
  const fetcher = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'heximons.lol') return Response.json(values);
    assert.equal(url.hostname, 'hexium.zip'); assert.equal(options.redirect, 'error');
    const cookie = options.headers.Cookie;
    const id = cookie === '.ROBLOSECURITY=hexium-test-cookie-account-one' ? 1 : cookie === '.ROBLOSECURITY=hexium-test-cookie-account-two' ? 2 : 0;
    if (!id) return new Response(null,{status:401});
    if (url.pathname.endsWith('/authenticated')) return Response.json({id,name:'Player'+id,displayName:'Player'+id});
    if (url.pathname.includes('/assets/collectibles')) return Response.json({data:inventories.get(Number(url.pathname.split('/')[5])),nextPageCursor:null});
    if (url.pathname.endsWith('/inbound')) {
      if (readFailure && sent) return new Response(null,{status:503});
      return Response.json({data:trade&&trade.isActive?[{id:trade.id,user:{id:trade.offers[0].user.id},isActive:true,status:'Open',created:trade.created}]:[],nextPageCursor:null});
    }
    if (url.pathname.endsWith('/send')) {
      if (csrf && !challenged) { challenged=true; return new Response(null,{status:403,headers:{'x-csrf-token':'challenge-token'}}); }
      if (csrf) assert.equal(options.headers['x-csrf-token'],'challenge-token');
      sent++;
      if (sendReject) return new Response(null,{status:403});
      const body = JSON.parse(options.body);
      trade = {id:900,created:new Date().toISOString(),isActive:true,status:'Open',offers:body.offers.map(o=>({user:{id:o.userId},robux:o.robux,userAssets:o.userAssetIds.map(x=>({id:badTrade?x+1000:x}))}))};
      if (sendTimeout) throw Error('Lost reply after side effect');
      return new Response(null,{status:200});
    }
    if (url.pathname.endsWith('/accept')) {
      accepted++;
      if (acceptReject) return new Response(null,{status:403});
      const [from,to]=trade.offers;
      const outgoing=from.userAssets.map(x=>x.id),incoming=to.userAssets.map(x=>x.id);
      const first=inventories.get(from.user.id),second=inventories.get(to.user.id);
      inventories.set(from.user.id,[...first.filter(x=>!outgoing.includes(x.userAssetId)),...second.filter(x=>incoming.includes(x.userAssetId))]);
      inventories.set(to.user.id,[...second.filter(x=>!incoming.includes(x.userAssetId)),...first.filter(x=>outgoing.includes(x.userAssetId))]);
      trade.status='Completed';trade.isActive=false;
      if (acceptTimeout) throw Error('Lost accept reply');
      return new Response(null,{status:200});
    }
    if (url.pathname.endsWith('/900')) return Response.json(trade);
    throw Error('Unexpected mock request '+url);
  };
  const lobby = new FlipLobby(ctx,{COOKIE_KEY:key});
  const env = {COOKIE_KEY:key,LOBBY:{idFromName:()=>1,get:()=>({fetch:r=>lobby.fetch(r)})}};
  const tokens = new Map();
  const call = async (path,body,id=1,extra={}) => {
    const headers={...extra,...(tokens.has(id)?{Cookie:tokens.get(id)}:{})};
    if (body!==undefined) {headers.Origin='https://flip.example';headers['Content-Type']='application/json'}
    const r=await worker.fetch(new Request('https://flip.example/api/'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)}),env);
    const cookie=r.headers.get('Set-Cookie');if(cookie)tokens.set(id,cookie.split(';')[0]);
    return {status:r.status,data:await r.json()};
  };
  async function setup() {
    for(const id of [1,2]) {
      assert.equal((await call('login',{cookie:id===1?'hexium-test-cookie-account-one':'hexium-test-cookie-account-two'},id)).status,200);
      assert.equal((await call('returns',{ids:id===1?[12,13,14]:[22,23,24]},id)).status,200);
    }
  }
  async function round() {
    const created=await call('create',{ids:multiStake?[11,15]:[11],clientSeed:'a'.repeat(64)},1);assert.equal(created.status,200);
    assert.equal(created.data.proof,null);
    const joined=await call('join',{gameId:created.data.id,ids:[21],commitment:created.data.commitment,clientSeed:'b'.repeat(64)},2);assert.equal(joined.status,200);
    await Promise.all(ctx.pending);
    return lobby.get('game',created.data.id);
  }
  return {ctx,lobby,call,setup,round,fetcher,counts:()=>({sent,accepted}),values,inventories,db};
}
async function usingRig(options, fn){const r=rig(options),old=globalThis.fetch;globalThis.fetch=r.fetcher;try{await fn(r)}finally{globalThis.fetch=old;r.db.close()}}

test('RAP fallback and inclusive 1% boundary',()=>{
  assert.deepEqual(effectiveValue({assetId:1,recentAveragePrice:50},{assets:{1:['x',null,55,0]}}),{amount:55,units:55000,source:'RAP'});
  assert.equal(effectiveValue({assetId:1,recentAveragePrice:50},{assets:{1:['x',null,55,100]}}).units,100000);
  assert.equal(effectiveValue({assetId:9,recentAveragePrice:50},{assets:{}}).amount,50);
  assert.equal(stakeMatch(100000,101000),true);assert.equal(stakeMatch(100000,101001),false);assert.equal(stakeMatch(0,0),false);
});
test('trade comparison requires both accounts, exact copy IDs, and no currency',()=>{
  const p={loserId:1,winnerId:2,stakeIds:[11,15],returnId:22};
  const t={offers:[{user:{id:2},userAssets:[{id:22}],robux:null},{user:{id:1},userAssets:[{id:15},{id:11}],robux:0}]};
  assert.equal(exactTrade(t,p),true);t.offers[0].robux=1;assert.equal(exactTrade(t,p),false);t.offers[0].robux=null;t.offers[0].userAssets[0].id=23;assert.equal(exactTrade(t,p),false);
});
test('draw is reproducible and independently matches HMAC ticket',async()=>{
  const g={id:'round',nonce:0,a:{id:1,total:100000,items:[{userAssetId:11}]},b:{id:2,total:101000,items:[{userAssetId:21}]},clientA:'a'.repeat(64),clientB:'b'.repeat(64)};
  const msg=proofMessage(g);const first=await draw('c'.repeat(64),msg,201000);assert.deepEqual(first,await draw('c'.repeat(64),msg,201000));
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode('c'.repeat(64)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const d=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(msg+':'+first.counter));const hex=Buffer.from(d).toString('hex');assert.equal(hex,first.digest);assert.equal(Number(BigInt('0x'+hex)%201000n),first.ticket);
});
test('login, origin checks, reservations, exact settlement, empty 200 bodies, proof export',()=>usingRig({},async r=>{
  await r.setup();assert.equal((await r.call('me')).data.user.id,1);
  const inv=await r.call('inventory');assert.equal(inv.data.items.length,4);
  const g=await r.round();assert.equal(g.state,'completed');assert.deepEqual(r.counts(),{sent:1,accepted:1});
  const pub=(await r.call('game/'+g.id)).data;assert.equal(pub.proof.winnerId,g.winnerId);assert.equal('payout' in pub,false);assert.equal(JSON.stringify(pub).includes('cookie'),false);
  const origin=await worker.fetch(new Request('https://flip.example/api/login',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'}),{LOBBY:{},COOKIE_KEY:key});assert.equal(origin.status,403);
}));
test('CSRF challenge retries a rejected write exactly once',()=>usingRig({csrf:true},async r=>{await r.setup();assert.equal((await r.round()).state,'completed');assert.deepEqual(r.counts(),{sent:1,accepted:1})}));
test('send timeout is reconciled without resending',()=>usingRig({sendTimeout:true},async r=>{await r.setup();let g=await r.round();assert.equal(g.state,'reconciling');await r.lobby.run(()=>r.lobby.settle(g.id));g=r.lobby.get('game',g.id);assert.equal(g.state,'completed');assert.deepEqual(r.counts(),{sent:1,accepted:1})}));
test('accept timeout is reconciled from inventories without another accept',()=>usingRig({acceptTimeout:true},async r=>{await r.setup();let g=await r.round();assert.equal(g.state,'reconciling');await r.lobby.run(()=>r.lobby.settle(g.id));g=r.lobby.get('game',g.id);assert.equal(g.state,'completed');assert.deepEqual(r.counts(),{sent:1,accepted:1})}));
test('wrong trade copies cannot be accepted',()=>usingRig({badTrade:true},async r=>{await r.setup();const g=await r.round();assert.equal(g.state,'reconciling');assert.equal(r.counts().accepted,0);assert.ok(r.lobby.locked(1).has(11));}));
test('read outage after sending retains reservations and cannot cancel or resend',()=>usingRig({readFailure:true},async r=>{await r.setup();const g=await r.round();assert.equal(g.state,'reconciling');assert.equal(r.counts().sent,1);assert.equal(r.counts().accepted,0);assert.ok(r.lobby.locked(1).has(11));}));
test('definite send rejection cancels; acceptance rejection retains outstanding trade',async()=>{
  await usingRig({sendReject:true},async r=>{await r.setup();assert.equal((await r.round()).state,'cancelled')});
  await usingRig({acceptReject:true},async r=>{await r.setup();const g=await r.round();assert.equal(g.state,'review');assert.ok(r.lobby.locked(1).has(11))});
});
test('small return items cannot also be staked, and another open round cannot reuse copies',()=>usingRig({},async r=>{
  await r.setup();assert.equal((await r.call('create',{ids:[12],clientSeed:'a'.repeat(64)})).status,400);
  const g=await r.call('create',{ids:[11],clientSeed:'a'.repeat(64)});assert.equal(g.status,200);
  assert.equal((await r.call('create',{ids:[11],clientSeed:'a'.repeat(64)})).status,400);
  assert.equal((await r.call('inventory')).data.locked.length,4);
}));
test('changed creator prices cancel before any trade is sent',()=>usingRig({},async r=>{
  await r.setup();const g=await r.call('create',{ids:[11],clientSeed:'a'.repeat(64)});
  r.values.assets['101'][3]=9000;r.lobby.valuesCache=null;
  const j=await r.call('join',{gameId:g.data.id,ids:[21],clientSeed:'b'.repeat(64),commitment:g.data.commitment},2);
  assert.equal(j.status,400);assert.equal(r.lobby.get('game',g.data.id).state,'cancelled');assert.equal(r.counts().sent,0);
}));
test('embedded browser JavaScript parses, no external dependencies',async()=>{
  const r=await worker.fetch(new Request('https://flip.example/'),{});const text=await r.text();new Function(text.match(/<script>([\s\S]*?)<\/script>/)[1]);assert.ok(text.includes('Verify locally'));
});

test('multiple stake copies match a single item and produce weighted odds',()=>usingRig({multiStake:true},async r=>{
  await r.setup();const g=await r.round();assert.equal(g.state,'completed');assert.equal(g.a.items.length,2);assert.equal(g.b.items.length,1);assert.equal(g.a.total,16000000);assert.equal(g.b.total,16001000);
  const pub=r.lobby.publicGame(g);assert.ok(pub.b.odds>0.5);assert.equal(g.payout.stakeIds.length,g.payout.loserId===1?2:1);
}));
test('persisted send stage survives a Durable Object restart',()=>usingRig({sendTimeout:true},async r=>{
  await r.setup();const g=await r.round();assert.equal(g.stage,'sending');const recovered=new FlipLobby(r.ctx,{COOKIE_KEY:key});await recovered.run(()=>recovered.settle(g.id));assert.equal(recovered.get('game',g.id).state,'completed');assert.deepEqual(r.counts(),{sent:1,accepted:1});
}));
