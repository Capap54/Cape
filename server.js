const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const OWNER_ID = '7275857070';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

app.use(express.static(PUBLIC_DIR));

const wallets = new Map();
const sessions = new Map();
const premiums = new Map();
const referrals = new Map();
const balances = new Map();
const searchUsage = new Map();
const claimedHandles = new Map();
const lots = [];

const CONS = ['b', 'c', 'd', 'f', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'x', 'z'];
const VOWS = ['a', 'e', 'i', 'o', 'u'];
const ROOTS = [
  'durov', 'fragment', 'telegram', 'crypto', 'ton', 'vip', 'god', 'king',
  'vortex', 'zenith', 'kobra', 'shadow', 'pulse', 'cyber', 'ghost', 'drift',
  'venom', 'frost', 'storm', 'titan', 'blade', 'spark', 'apex', 'nova'
];

function rand(n) { return crypto.randomInt(0, n); }
function clean(s) { return String(s || '').trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_]/g, ''); }
function valid(u) { return /^[a-z][a-z0-9_]{3,31}$/.test(u); }
function dayKey() { return new Date().toISOString().slice(0, 10); }

function isOwner(uid) {
  return String(uid || '').trim() === OWNER_ID;
}

function getPrem(uid) {
  if (isOwner(uid)) return Number.MAX_SAFE_INTEGER;
  const t = Number(premiums.get(String(uid)) || 0);
  return t > Date.now() ? t : 0;
}

function getRefs(uid) {
  return Math.max(0, Number(referrals.get(String(uid)) || 0));
}

function getBal(uid) {
  const k = String(uid);
  const cur = balances.get(k);
  if (cur) return cur;
  const init = { ton: 0, stars: 0 };
  balances.set(k, init);
  return init;
}

function getClaimedList(uid) {
  return claimedHandles.get(String(uid)) || [];
}

function getSearchesToday(uid) {
  const rec = searchUsage.get(String(uid));
  if (!rec || rec.day !== dayKey()) return 0;
  return Number(rec.count || 0);
}

function incSearchesToday(uid) {
  const k = String(uid);
  const today = dayKey();
  const prev = searchUsage.get(k);
  const next = prev && prev.day === today ? Number(prev.count || 0) + 1 : 1;
  searchUsage.set(k, { day: today, count: next });
  return next;
}

function syllables(len) {
  let out = '';
  let c = rand(2) === 0;
  while (out.length < len) {
    out += c ? CONS[rand(CONS.length)] : VOWS[rand(VOWS.length)];
    c = !c;
  }
  return out.slice(0, len);
}

function genName(style) {
  if (style === 'len5') return syllables(5);
  if (style === 'short6') return syllables(6);
  if (style === 'premium_hunt') {
    const list = ROOTS.filter((r) => r.length <= 7);
    const root = list[rand(list.length)] || 'vortex';
    const len = 5 + rand(3);
    if (root.length >= len) return root.slice(0, len);
    return (root + syllables(len - root.length)).slice(0, len);
  }
  if (style === 'rare') {
    const len = 6 + rand(3);
    const list = ROOTS.filter((r) => r.length <= len);
    const root = list[rand(list.length)] || 'vortex';
    return (root + syllables(Math.max(0, len - root.length))).slice(0, len);
  }
  if (style === 'with_num') {
    const len = 6 + rand(3);
    return syllables(Math.max(4, len - 2)) + String(rand(90) + 10);
  }
  if (style === 'with_under') {
    const len = 6 + rand(3);
    const h = Math.max(2, Math.floor((len - 1) / 2));
    return (syllables(h) + '_' + syllables(Math.max(2, len - 1 - h))).slice(0, len);
  }
  return syllables(6 + rand(3));
}

async function fetchTimeout(url) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), 4500);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
  } finally {
    clearTimeout(id);
  }
}

async function checkBot(u) {
  if (!BOT_TOKEN) return { checked: false, taken: false };
  try {
    const r = await fetchTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=@${encodeURIComponent(u)}`);
    const j = await r.json();
    if (j && j.ok) return { checked: true, taken: true };
    const d = String(j?.description || '').toLowerCase();
    if (d.includes('chat not found') || d.includes('username not occupied')) return { checked: true, taken: false };
    return { checked: true, taken: true };
  } catch (_) { return { checked: false, taken: false }; }
}

async function checkTme(u) {
  try {
    const r = await fetchTimeout(`https://t.me/${encodeURIComponent(u)}`);
    const html = await r.text();
    const low = html.toLowerCase();
    const has = html.includes('tgme_page_title') || html.includes('tgme_page_extra') ||
      html.includes('tgme_page_description') || low.includes('subscribers') || low.includes('members');
    const freeHint = low.includes('if you have <strong>telegram</strong>, you can contact');
    return { checked: true, taken: Boolean(has && !freeHint) };
  } catch (_) { return { checked: false, taken: false }; }
}

async function checkFrag(u) {
  try {
    const r = await fetchTimeout(`https://fragment.com/username/${encodeURIComponent(u)}`);
    const low = (await r.text()).toLowerCase();
    const markers = [
      'on auction', 'place a bid', 'highest bid', 'make an offer',
      'buy now', 'sold', 'unavailable', 'taken', 'collectible', 'minimum bid', 'ton'
    ];
    const busy = markers.some((m) => low.includes(m));
    const free = low.includes('username is available') || low.includes('this username is available');
    return { checked: true, taken: busy && !free };
  } catch (_) { return { checked: false, taken: false }; }
}

function isAlreadyClaimedInApp(u) {
  for (const list of claimedHandles.values()) {
    if (list.some((x) => x.username === u)) return true;
  }
  return false;
}

async function checkStrict(u) {
  if (isAlreadyClaimedInApp(u)) {
    return {
      ok: true,
      username: u,
      length: u.length,
      available: false,
      badge: { code: 'taken', label: 'Уже занят' },
      checks: { botApi: { checked: true, taken: true }, tMe: { checked: false, taken: false }, fragment: { checked: false, taken: false } }
    };
  }
  const [botApi, tMe, fragment] = await Promise.all([checkBot(u), checkTme(u), checkFrag(u)]);
  const taken = Boolean(botApi.taken || tMe.taken || fragment.taken);
  const rare = ROOTS.some((r) => u.includes(r)) || u.length <= 6;
  let badge = { code: 'available', label: 'Свободен' };
  if (fragment.taken) badge = { code: 'fragment', label: 'Fragment / Занят' };
  else if (taken) badge = { code: 'taken', label: 'Занят' };
  else if (rare) badge = { code: 'rare_premium', label: 'Редкий' };
  return { ok: true, username: u, length: u.length, available: !taken, badge, checks: { botApi, tMe, fragment } };
}

function getProfile(uid) {
  const base = sessions.get(uid) || { userId: uid, name: 'Игрок', searches: 0, checks: 0, valuations: 0 };
  const bal = getBal(uid);
  const usedToday = getSearchesToday(uid);
  const owner = isOwner(uid);
  const premUntil = getPrem(uid);
  const hasPrem = owner || premUntil > Date.now();
  return {
    ...base,
    ton: Number(bal.ton.toFixed(2)),
    stars: Math.floor(bal.stars),
    permanentPremium: owner,
    premiumUntil: owner ? 0 : premUntil,
    referrals: getRefs(uid),
    wallet: wallets.get(uid) || '',
    claimed: getClaimedList(uid),
    searchesToday: usedToday,
    freeSearchesLeft: hasPrem ? 999 : Math.max(0, 5 - usedToday)
  };
}

async function botCall(method, payload) {
  if (!BOT_TOKEN) return null;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.json();
}

app.post('/api/stars/invoice', async (req, res) => {
  const uid = String(req.body?.userId || '').trim();
  if (!uid) return res.status(400).json({ ok: false, error: 'Открой приложение в Telegram' });
  if (!BOT_TOKEN) {
    return res.status(400).json({ ok: false, error: 'Добавь BOT_TOKEN в Environment на Render' });
  }
  try {
    const data = await botCall('createInvoiceLink', {
      title: 'Cap-App Премиум (30 дней)',
      description: 'Премиум-доступ к поиску и редким юзам на 30 дней',
      payload: JSON.stringify({ uid, plan: 'prem_30d', stars: 50 }),
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Премиум на 30 дней', amount: 50 }]
    });
    if (!data || !data.ok || !data.result) {
      return res.status(400).json({ ok: false, error: data?.description || 'Ошибка создания счёта Stars' });
    }
    res.json({ ok: true, invoiceLink: data.result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Ошибка при создании счёта Stars' });
  }
});

app.post('/api/telegram/webhook', async (req, res) => {
  const upd = req.body || {};
  try {
    if (upd.pre_checkout_query && BOT_TOKEN) {
      await botCall('answerPreCheckoutQuery', {
        pre_checkout_query_id: upd.pre_checkout_query.id,
        ok: true
      });
    }
    const msg = upd.message;
    if (msg && msg.successful_payment && msg.successful_payment.currency === 'XTR') {
      let uid = String(msg.from?.id || '');
      try {
        const parsed = JSON.parse(msg.successful_payment.invoice_payload || '{}');
        if (parsed.uid) uid = String(parsed.uid);
      } catch (_) {}
      if (uid) {
        premiums.set(uid, Math.max(Date.now(), getPrem(uid)) + MONTH_MS);
      }
    }
  } catch (_) {}
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/session', (req, res) => {
  const uid = String(req.body?.userId || 'guest').trim() || 'guest';
  const name = String(req.body?.name || 'Игрок').trim().slice(0, 32) || 'Игрок';
  const refBy = String(req.body?.refBy || '').trim();
  if (refBy && refBy !== uid) referrals.set(refBy, getRefs(refBy) + 1);
  const prev = sessions.get(uid) || { searches: 0, checks: 0, valuations: 0 };
  sessions.set(uid, { userId: uid, name, searches: prev.searches, checks: prev.checks, valuations: prev.valuations });
  res.json({ ok: true, profile: getProfile(uid) });
});

app.post('/api/claim', async (req, res) => {
  const uid = String(req.body?.userId || 'guest').trim() || 'guest';
  const u = clean(req.body?.username || '');
  if (!valid(u)) return res.status(400).json({ ok: false, error: 'Некорректный юзернейм' });
  if (isAlreadyClaimedInApp(u)) {
    return res.status(400).json({ ok: false, error: `@${u} уже занят`, profile: getProfile(uid) });
  }
  const checked = await checkStrict(u);
  if (!checked.available) {
    return res.status(400).json({ ok: false, error: `@${u} занят или недоступен`, profile: getProfile(uid) });
  }
  const list = getClaimedList(uid);
  list.unshift({ username: u, claimedAt: Date.now() });
  claimedHandles.set(uid, list);
  res.json({ ok: true, username: u, profile: getProfile(uid) });
});

app.post('/api/referral/add', (req, res) => {
  const uid = String(req.body?.userId || 'guest');
  referrals.set(uid, getRefs(uid) + 1);
  res.json({ ok: true, profile: getProfile(uid) });
});

app.post('/api/referral/redeem', (req, res) => {
  const uid = String(req.body?.userId || 'guest');
  const count = getRefs(uid);
  if (count < 2) return res.status(400).json({ ok: false, error: 'Нужно минимум 2 реферала', profile: getProfile(uid) });
  referrals.set(uid, count - 2);
  premiums.set(uid, Math.max(Date.now(), getPrem(uid)) + DAY_MS);
  res.json({ ok: true, profile: getProfile(uid) });
});

app.post('/api/stats', (req, res) => {
  const uid = String(req.body?.userId || 'guest');
  const act = String(req.body?.action || '');
  const cur = sessions.get(uid) || { userId: uid, name: 'Игрок', searches: 0, checks: 0, valuations: 0 };
  if (act === 'search') cur.searches += 1;
  if (act === 'check') cur.checks += 1;
  if (act === 'valuation') cur.valuations += 1;
  sessions.set(uid, cur);
  res.json({ ok: true, profile: getProfile(uid) });
});

app.get('/api/check', async (req, res) => {
  const u = clean(req.query.username || '');
  if (!valid(u)) return res.status(400).json({ ok: false, message: 'Нужно 4–32 символа (латиница, цифры, _)' });
  res.json(await checkStrict(u));
});

app.get('/api/generate', async (req, res) => {
  const uid = String(req.query.userId || 'guest');
  const owner = isOwner(uid);
  const hasPrem = owner || getPrem(uid) > Date.now();
  if (!hasPrem && getSearchesToday(uid) >= 5) {
    return res.status(429).json({
      ok: false,
      message: 'Лимит 5 бесплатных поисков в день исчерпан (50 ★/мес или 2 реферала = 1 день).',
      profile: getProfile(uid)
    });
  }
  const count = Math.min(Math.max(Number(req.query.count) || 5, 1), 10);
  const style = String(req.query.style || 'rare');
  if ((style === 'len5' || style === 'premium_hunt') && !hasPrem) {
    return res.status(403).json({ ok: false, message: 'Нужен Премиум (50 ★/мес или 2 реферала = 1 день)' });
  }
  if (!hasPrem) incSearchesToday(uid);

  const seen = new Set();
  const items = [];
  let scanned = 0;
  const maxAttempts = 300;
  for (let i = 0; i < maxAttempts && items.length < count; i++) {
    const u = genName(style);
    if (!valid(u) || seen.has(u)) continue;
    seen.add(u);
    scanned += 1;
    const item = await checkStrict(u);
    if (item.available) items.push(item);
  }
  res.json({ ok: true, scanned, items, profile: getProfile(uid) });
});

app.get('/api/market', (req, res) => res.json({ ok: true, listings: lots }));

app.post('/api/market', (req, res) => {
  const username = clean(req.body?.username || '');
  const priceTon = Number(req.body?.priceTon);
  const sellerId = String(req.body?.sellerId || 'guest');
  const sellerName = String(req.body?.sellerName || 'Игрок').trim().slice(0, 32) || 'Игрок';
  if (!valid(username) || !Number.isFinite(priceTon) || priceTon <= 0) {
    return res.status(400).json({ ok: false, error: 'Проверь юзернейм и цену TON' });
  }
  const lot = { id: 'lot_' + Date.now(), username, priceTon, sellerId, sellerName, sold: false };
  lots.unshift(lot);
  res.json({ ok: true, listing: lot });
});

app.post('/api/market/buy', (req, res) => {
  const id = String(req.body?.id || '');
  const buyerId = String(req.body?.buyerId || 'guest');
  const buyerName = String(req.body?.buyerName || 'Игрок').trim().slice(0, 32) || 'Игрок';
  const lot = lots.find((l) => l.id === id);
  if (!lot) return res.status(404).json({ ok: false, error: 'Лот не найден' });
  if (lot.sold) return res.status(400).json({ ok: false, error: 'Лот уже куплен' });
  if (lot.sellerId === buyerId) return res.status(400).json({ ok: false, error: 'Нельзя купить свой лот' });

  const buyerBal = getBal(buyerId);
  if (buyerBal.ton < lot.priceTon) {
    return res.status(400).json({ ok: false, error: `Недостаточно TON (нужно ${lot.priceTon} TON)` });
  }
  buyerBal.ton = Number((buyerBal.ton - lot.priceTon).toFixed(2));
  balances.set(buyerId, buyerBal);

  const sellerBal = getBal(lot.sellerId);
  sellerBal.ton = Number((sellerBal.ton + lot.priceTon).toFixed(2));
  balances.set(lot.sellerId, sellerBal);

  lot.sold = true;
  lot.buyerName = buyerName;
  res.json({ ok: true, listing: lot, profile: getProfile(buyerId) });
});

app.post('/api/wallet', (req, res) => {
  const uid = String(req.body?.userId || 'guest');
  const address = String(req.body?.address || '').trim();
  if (!address) return res.status(400).json({ ok: false, error: 'Введите адрес кошелька' });
  wallets.set(uid, address);
  res.json({ ok: true, address, profile: getProfile(uid) });
});

app.get('*', (req, res) => {
  if (fs.existsSync(INDEX_FILE)) return res.sendFile(INDEX_FILE);
  res.status(404).send('public/index.html not found');
});

app.listen(PORT, () => console.log('Cap-App running on ' + PORT));
