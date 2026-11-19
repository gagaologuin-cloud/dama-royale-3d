/* DAMA ROYALE 3D - Cloud Functions (server is the ONLY writer of coins, results, trades, purchases)
   Deploy: firebase deploy --only functions,database */
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { google } = require('googleapis');

setGlobalOptions({ region: 'asia-southeast1' });

admin.initializeApp();
const db = admin.database();

const HE = (code, msg) => new HttpsError(code, msg);
const uidOf = (req) => {
  if (!req.auth) throw HE('unauthenticated', 'Sign in required');
  return req.auth.uid;
};
const today = () => new Date().toISOString().slice(0, 10);
const yest = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

// ===== DAMA ENGINE (authoritative server move validation) =====
const D = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ow = (v) => (v ? (v % 2 ? 1 : 2) : 0);
const kg = (v) => v > 2;
const In = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function caps(b, s, p, out) {
  const k = kg(b[s]);
  const bb = b.slice();
  bb[s] = 0;
  (function j(pos, cap, path) {
    let f = 0;
    for (const [dr, dc] of D) {
      let r = (pos / 8 | 0) + dr;
      let c = (pos % 8) + dc;
      if (k) while (In(r, c) && !bb[r * 8 + c]) { r += dr; c += dc; }
      if (!In(r, c)) continue;
      const q = r * 8 + c;
      if (ow(bb[q]) !== 3 - p || cap.includes(q)) continue;
      r += dr;
      c += dc;
      while (In(r, c) && !bb[r * 8 + c]) {
        f = 1;
        const l = r * 8 + c;
        j(l, [...cap, q], [...path, l]);
        if (!k) break;
        r += dr;
        c += dc;
      }
    }
    if (!f && cap.length) out.push({ p: path, c: cap });
  })(s, [], [s]);
}

function moves(b, p) {
  const o = [];
  for (let i = 0; i < 64; i++) if (ow(b[i]) === p) caps(b, i, p, o);
  if (o.length) return o;
  for (let i = 0; i < 64; i++) {
    if (ow(b[i]) === p) {
      const k = kg(b[i]);
      for (const [dr, dc] of D) {
        if (!k && dr !== (p === 1 ? -1 : 1)) continue;
        let r = (i / 8 | 0) + dr;
        let c = (i % 8) + dc;
        while (In(r, c) && !b[r * 8 + c]) {
          o.push({ p: [i, r * 8 + c], c: [] });
          if (!k) break;
          r += dr;
          c += dc;
        }
      }
    }
  }
  return o;
}

function ap(b, m) {
  const n = b.slice();
  const s = m.p[0];
  const e = m.p[m.p.length - 1];
  let v = n[s];
  n[s] = 0;
  m.c.forEach((i) => { n[i] = 0; });
  if (v < 3 && ((v === 1 && e < 8) || (v === 2 && e > 55))) v += 2;
  n[e] = v;
  return n;
}

const INIT = (() => {
  const b = Array(64).fill(0);
  for (let i = 0; i < 64; i++) {
    const r = i >> 3;
    const c = i % 8;
    if ((r + c) % 2) {
      if (r < 3) b[i] = 2;
      else if (r > 4) b[i] = 1;
    }
  }
  return b.join('');
})();

// ===== COIN HELPERS =====
const inc = (path, delta) => db.ref(path).transaction((v) => (v || 0) + delta);

async function spend(uid, amount) {
  let ok = false;
  await db.ref(`users/${uid}/coins`).transaction((v) => {
    ok = false;
    if (v === null || v === undefined) return 0;
    if (v < amount) return;
    ok = true;
    return v - amount;
  });
  if (!ok) throw HE('failed-precondition', 'Not enough coins');
}

const getUser = async (uid) => {
  const snap = await db.ref(`users/${uid}`).once('value');
  const v = snap.val();
  if (!v) throw HE('not-found', 'User profile not found');
  return v;
};

const slim = (p) => ({
  uid: p.uid,
  name: p.name,
  cc: p.cc,
  av: p.av || 'RM'
});

// ===== ACCOUNTS & REWARDS =====
exports.ensureUser = onCall(async (req) => {
  const u = uidOf(req);
  const d = req.data || {};
  const ref = db.ref(`users/${u}`);
  const cleanName = String(d.name || 'Player').replace(/[<>&"]/g, '').trim().slice(0, 14) || 'Player';
  const cleanCc = String(d.cc || 'PH').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2) || 'PH';
  const cleanAv = String(d.av || 'RM').replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'RM';

  const snap = await ref.once('value');
  if (!snap.exists()) {
    await ref.set({
      name: cleanName,
      cc: cleanCc,
      av: cleanAv,
      coins: 1000,
      practiceCoins: 1000,
      wins: 0,
      points: 0,
      elo: 1200,
      own: { wood: 1 },
      online: true,
      lastSeen: Date.now()
    });
  } else {
    await ref.update({
      name: cleanName,
      cc: cleanCc,
      av: cleanAv,
      online: true,
      lastSeen: Date.now()
    });
  }
  return { ok: 1 };
});

exports.claimDaily = onCall(async (req) => {
  const u = uidOf(req);
  let add = 0;
  await db.ref(`users/${u}/daily`).transaction((d) => {
    add = 0;
    d = d || { last: '', day: 0 };
    if (d.last === today()) return d;
    const day = d.last === yest() ? (d.day + 1) % 7 : 0;
    add = 20;
    return { last: today(), day };
  });
  if (!add) throw HE('already-exists', 'Daily bonus already claimed today');
  await inc(`users/${u}/coins`, add);
  return { coins: add };
});

exports.claimReward = onCall(async (req) => {
  const u = uidOf(req);
  let add = 0;
  await db.ref(`users/${u}/ad`).transaction((a) => {
    add = 0;
    const now = Date.now();
    a = a && a.d === today() ? a : { t: 0, n: 0, d: today() };
    if (now - a.t < 30000 || a.n >= 20) return a;
    add = 50;
    return { t: now, n: a.n + 1, d: today() };
  });
  if (!add) throw HE('resource-exhausted', 'Cooldown 30s or daily limit reached');
  await inc(`users/${u}/coins`, add);
  return { coins: add };
});

exports.claimComment = onCall(async (req) => {
  const u = uidOf(req);
  let add = 0;
  await db.ref(`users/${u}/cm`).transaction((c) => {
    add = 0;
    c = c && c.d === today() ? c : { d: today(), n: 0 };
    if (c.n >= 6) return c;
    add = 5;
    return { d: c.d, n: c.n + 1 };
  });
  if (!add) throw HE('resource-exhausted', 'Daily comment reward limit (6/day) reached');
  await inc(`users/${u}/coins`, add);
  return { coins: add };
});

// ===== ROOMS & GAMEPLAY =====
async function makeRoom(a, b, o = {}) {
  const id = db.ref('rooms').push().key;
  const now = Date.now();
  await db.ref(`rooms/${id}`).set({
    p1: slim(a),
    p2: slim(b),
    status: 'playing',
    turn: 1,
    board: INIT,
    cap: [0, 0],
    clock: [300, 300],
    at: now,
    n: 0,
    fr: o.fr ? 1 : 0,
    created: now
  });
  await Promise.all([
    db.ref(`users/${a.uid}/joinRoom`).set(id),
    db.ref(`users/${b.uid}/joinRoom`).set(id)
  ]);
  return id;
}

function fin(R, w, why, o) {
  R.status = 'done';
  R.winner = w ? (w === 1 ? R.p1.uid : R.p2.uid) : null;
  R.why = why;
  o.fin = 1;
  return R;
}

async function mutate(room, fn) {
  const o = {};
  const res = await db.ref(`rooms/${room}`).transaction((R) => {
    o.err = null;
    o.fin = 0;
    if (!R) return R;
    if (R.status !== 'playing') {
      o.err = 'Match already finished';
      return;
    }
    return fn(R, Date.now(), o);
  });
  const v = res.snapshot.val();
  if (!v) throw HE('not-found', 'Room not found');
  if (o.err) throw HE('failed-precondition', o.err);
  if (o.fin) await settle(room, v);
  return v;
}

const sideOf = (R, u) => (R.p1.uid === u ? 1 : R.p2.uid === u ? 2 : 0);

async function settle(roomId, R) {
  if (R.fr) return;
  const settlementRef = db.ref(`rooms/${roomId}/settled`);
  let shouldSettle = false;
  await settlementRef.transaction((cur) => {
    if (cur) return cur;
    shouldSettle = true;
    return true;
  });
  if (!shouldSettle) return;

  const w = R.winner;
  if (w) {
    const l = w === R.p1.uid ? R.p2.uid : R.p1.uid;
    await inc(`users/${w}/coins`, 40);
    await inc(`users/${w}/wins`, 1);
    await inc(`users/${w}/points`, 25);
    await inc(`users/${w}/elo`, 10);
    await db.ref(`users/${l}/elo`).transaction((v) => Math.max(800, (v || 1200) - 10));
  } else {
    await inc(`users/${R.p1.uid}/coins`, 20);
    await inc(`users/${R.p2.uid}/coins`, 20);
  }
}

exports.submitMove = onCall(async (req) => {
  const u = uidOf(req);
  const { room, path } = req.data || {};
  if (!room || !Array.isArray(path)) throw HE('invalid-argument', 'Invalid move payload');

  await mutate(room, (R, now, o) => {
    const s = sideOf(R, u);
    if (!s || R.turn !== s) {
      o.err = 'Not your turn';
      return;
    }
    const clk = [...(R.clock || [300, 300])];
    clk[s - 1] -= (now - (R.at || now)) / 1000;
    if (clk[s - 1] <= 0) {
      clk[s - 1] = 0;
      R.clock = clk;
      return fin(R, 3 - s, 'timeout', o);
    }
    const b = String(R.board || INIT).split('').map(Number);
    const m = moves(b, s).find((x) => x.p.length === path.length && x.p.every((v, i) => v === path[i]));
    if (!m) {
      o.err = 'Illegal move';
      return;
    }
    const nb = ap(b, m);
    const cap = [...(R.cap || [0, 0])];
    cap[s - 1] += m.c.length;
    Object.assign(R, {
      board: nb.join(''),
      turn: 3 - s,
      clock: clk,
      at: now,
      n: (R.n || 0) + 1,
      last: [m.p[0], m.p[m.p.length - 1]],
      cap
    });
    if (!moves(nb, 3 - s).length) return fin(R, s, 'blocked', o);
    if (R.n > 150) return fin(R, 0, 'draw', o);
    return R;
  });
  return { ok: 1 };
});

exports.claimTimeout = onCall(async (req) => {
  const u = uidOf(req);
  const { room } = req.data || {};
  if (!room) throw HE('invalid-argument', 'Room required');
  await mutate(room, (R, now, o) => {
    if (!sideOf(R, u)) {
      o.err = 'Not a match player';
      return;
    }
    const clk = [...(R.clock || [300, 300])];
    if (clk[R.turn - 1] - (now - (R.at || now)) / 1000 > 1) {
      o.err = 'Clock has not expired';
      return;
    }
    clk[R.turn - 1] = 0;
    R.clock = clk;
    return fin(R, 3 - R.turn, 'timeout', o);
  });
  return { ok: 1 };
});

exports.resign = onCall(async (req) => {
  const u = uidOf(req);
  const { room } = req.data || {};
  if (!room) throw HE('invalid-argument', 'Room required');
  await mutate(room, (R, _now, o) => {
    const s = sideOf(R, u);
    if (!s) {
      o.err = 'Not a match player';
      return;
    }
    return fin(R, 3 - s, 'resign', o);
  });
  return { ok: 1 };
});

exports.claimDisconnect = onCall(async (req) => {
  const u = uidOf(req);
  const { room } = req.data || {};
  if (!room) throw HE('invalid-argument', 'Room required');
  const R0 = (await db.ref(`rooms/${room}`).once('value')).val();
  if (!R0) throw HE('not-found', 'Room not found');
  const s = sideOf(R0, u);
  if (!s) throw HE('permission-denied', 'Not a match player');
  const oppUid = s === 1 ? R0.p2.uid : R0.p1.uid;
  const ou = await getUser(oppUid);
  if (ou.online !== false || Date.now() - (ou.lastSeen || 0) < 30000) {
    throw HE('failed-precondition', 'Opponent is still connected');
  }
  await mutate(room, (R, _now, o) => fin(R, s, 'disconnect', o));
  return { ok: 1 };
});

// ===== WORLDWIDE MATCHMAKING =====
exports.joinQueue = onCall(async (req) => {
  const u = uidOf(req);
  const me = await getUser(u);
  if ((await db.ref(`queue/${u}`).once('value')).exists()) {
    throw HE('already-exists', 'Already searching for a match');
  }
  await spend(u, 20);
  const mine = {
    uid: u,
    name: me.name,
    cc: me.cc,
    av: me.av || 'RM',
    elo: me.elo || 1200,
    t: Date.now()
  };
  let pair = null;
  await db.ref('queue').transaction((q) => {
    pair = null;
    q = q || {};
    q[u] = mine;
    const opp = Object.values(q).find((x) => x && x.uid !== u && Math.abs((x.elo || 1200) - mine.elo) <= 400);
    if (opp) {
      pair = [opp, mine];
      delete q[opp.uid];
      delete q[u];
    }
    return q;
  });
  if (pair) await makeRoom(pair[0], pair[1]);
  return { matched: !!pair };
});

exports.leaveQueue = onCall(async (req) => {
  const u = uidOf(req);
  let refunded = false;
  await db.ref('queue').transaction((q) => {
    refunded = false;
    if (q && q[u]) {
      refunded = true;
      delete q[u];
    }
    return q;
  });
  if (refunded) await inc(`users/${u}/coins`, 20);
  return { refunded };
});

// ===== MARKETPLACE (10% fee in Coins) =====
const SKINS = ['gold', 'fire', 'galaxy', 'gp', 'dp'];

exports.createOffer = onCall(async (req) => {
  const u = uidOf(req);
  const { skin, coins } = req.data || {};
  if (!SKINS.includes(skin)) throw HE('invalid-argument', 'Invalid skin');
  if (!Number.isInteger(coins) || coins < 100 || coins > 1000000) {
    throw HE('invalid-argument', 'Price must be between 100 and 1,000,000 Coins');
  }
  const ref = db.ref(`users/${u}/own/${skin}`);
  let took = false;
  await ref.transaction((v) => {
    took = false;
    if (!v) return v;
    took = true;
    return null;
  });
  if (!took) throw HE('failed-precondition', 'You do not own this skin');
  const me = await getUser(u);
  for (const [k, v] of Object.entries(me.eq || {})) {
    if (v === skin) await db.ref(`users/${u}/eq/${k}`).remove();
  }
  await db.ref('marketplace').push({
    sellerID: u,
    sellerUsername: me.name,
    sellerFlag: me.cc,
    skin,
    coins,
    t: Date.now()
  });
  return { ok: 1 };
});

exports.cancelOffer = onCall(async (req) => {
  const u = uidOf(req);
  const id = (req.data || {}).id;
  if (!id) throw HE('invalid-argument', 'Offer ID required');
  const ref = db.ref(`marketplace/${id}`);
  let off = null;
  await ref.transaction((v) => {
    off = null;
    if (!v) return v;
    if (v.sellerID !== u) return;
    off = v;
    return null;
  });
  if (!off) throw HE('not-found', 'Offer not found or not owned by you');
  await db.ref(`users/${u}/own/${off.skin}`).set(1);
  return { ok: 1 };
});

exports.acceptOffer = onCall(async (req) => {
  const u = uidOf(req);
  const id = (req.data || {}).id;
  if (!id) throw HE('invalid-argument', 'Offer ID required');
  const ref = db.ref(`marketplace/${id}`);
  let off = null;
  await ref.transaction((v) => {
    off = null;
    if (!v) return v;
    if (v.sellerID === u) return;
    off = v;
    return null;
  });
  if (!off) throw HE('not-found', 'Offer no longer available');
  try {
    await spend(u, off.coins);
  } catch (e) {
    await ref.set(off);
    throw e;
  }
  const fee = Math.floor(off.coins * 0.1);
  const net = off.coins - fee;
  await inc(`users/${off.sellerID}/coins`, net);
  await inc('stats/fees', fee);
  await db.ref(`users/${u}/own/${off.skin}`).set(1);
  await db.ref(`earnings/${off.sellerID}/${id}`).set({
    skin: off.skin,
    coins: off.coins,
    fee,
    net,
    t: Date.now()
  });
  return { ok: 1 };
});

// ===== GOOGLE PLAY BILLING VERIFICATION =====
const PKG = 'com.damaroyale3d.app';
const play = google.androidpublisher({
  version: 'v3',
  auth: new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/androidpublisher'] })
});

const CATALOG = {
  coins_bronze: { coins: 1000 },
  coins_starter: { coins: 5500 },
  coins_gold: { coins: 16000 },
  coins_plat: { coins: 35000 },
  coins_silver: { coins: 85000 },
  coins_vip: { coins: 190000 },
  sub_pro_month: { sub: 1, mem: 1 },
  sub_pro_year: { sub: 1, mem: 1 },
  vip_life: { mem: 1 }
};
['re', 'fe', 'gb', 'de', 'rb', 'vb', 'rc', 'gf', 'ff', 'dc', 'fr', 'ah', 'gold', 'fire', 'galaxy', 'gp', 'dp'].forEach((item) => {
  CATALOG[`item_${item}`] = { own: item };
});

exports.verifyPurchase = onCall(async (req) => {
  const u = uidOf(req);
  const { sku, token } = req.data || {};
  const p = CATALOG[sku];
  if (!p || typeof token !== 'string' || token.length < 10) {
    throw HE('invalid-argument', 'Invalid purchase SKU or token');
  }
  const key = crypto.createHash('sha256').update(token).digest('hex').slice(0, 40);
  let st = 'new';
  await db.ref(`purchases/${key}`).transaction((v) => {
    st = 'new';
    if (!v) return { uid: u, sku, t: Date.now() };
    if (v.uid !== u) {
      st = 'stolen';
      return;
    }
    st = 'seen';
    return v;
  });
  if (st === 'stolen' || (st === 'seen' && !p.sub)) {
    throw HE('already-exists', 'Purchase token already processed');
  }

  let until = 0;
  try {
    if (p.sub) {
      const r = (await play.purchases.subscriptionsv2.get({ packageName: PKG, token })).data;
      const li = (r.lineItems || []).find((x) => x.productId === sku);
      if (!li || !['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'].includes(r.subscriptionState)) {
        throw new Error('Subscription inactive');
      }
      until = Date.parse(li.expiryTime);
      if (r.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
        await play.purchases.subscriptions.acknowledge({ packageName: PKG, subscriptionId: sku, token, requestBody: {} });
      }
    } else {
      const r = (await play.purchases.products.get({ packageName: PKG, productId: sku, token })).data;
      if (r.purchaseState !== 0) throw new Error('Purchase not completed');
      if (!p.coins && r.acknowledgementState === 0) {
        await play.purchases.products.acknowledge({ packageName: PKG, productId: sku, token, requestBody: {} });
      }
    }
  } catch (_) {
    if (st === 'new') await db.ref(`purchases/${key}`).remove();
    throw HE('failed-precondition', 'Google Play purchase verification failed');
  }

  if (st === 'new') {
    if (p.coins) await inc(`users/${u}/coins`, p.coins);
    if (p.own) await db.ref(`users/${u}/own/${p.own}`).set(1);
  }
  if (p.mem) await db.ref(`users/${u}/mem`).set({ sku, until: p.sub ? until : 0 });
  await db.ref(`purchases/${key}`).update({ state: 'granted' });
  return { ok: 1 };
});

// ===== SCHEDULED CLEANUP (timeouts, disconnects, stale queue) =====
exports.tick = onSchedule('every 1 minutes', async () => {
  const now = Date.now();
  const rooms = (await db.ref('rooms').orderByChild('status').equalTo('playing').once('value')).val() || {};
  for (const [id, R] of Object.entries(rooms)) {
    let loser = 0;
    let why = '';
    const clk = R.clock || [300, 300];
    if (clk[R.turn - 1] - (now - (R.at || now)) / 1000 <= 0) {
      loser = R.turn;
      why = 'timeout';
    } else {
      const us = await Promise.all([R.p1.uid, R.p2.uid].map(async (uid) => (await db.ref(`users/${uid}`).once('value')).val() || {}));
      const off = (u) => u.online === false && now - (u.lastSeen || 0) > 30000;
      if (off(us[0]) && off(us[1])) loser = R.turn;
      else if (off(us[0])) loser = 1;
      else if (off(us[1])) loser = 2;
      if (loser) why = 'disconnect';
    }
    if (loser) {
      await mutate(id, (R2, n2, o) => {
        const c2 = R2.clock || [300, 300];
        if (why === 'timeout' && c2[R2.turn - 1] - (n2 - (R2.at || n2)) / 1000 > 0) {
          o.err = 'moved';
          return;
        }
        return fin(R2, 3 - loser, why, o);
      }).catch(() => {});
    }
  }

  const q = (await db.ref('queue').once('value')).val() || {};
  for (const [uid, item] of Object.entries(q)) {
    if (now - (item.t || 0) > 180000) {
      let refunded = false;
      await db.ref('queue').transaction((c) => {
        refunded = false;
        if (c && c[uid]) {
          refunded = true;
          delete c[uid];
        }
        return c;
      });
      if (refunded) await inc(`users/${uid}/coins`, 20);
    }
  }
});