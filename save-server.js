// Brawl Arena cloud-save server.
// Saves go to Postgres when DATABASE_URL is set, so they survive restarts and
// redeploys. Without it, it falls back to saves.json next to this file, which
// is fine on your own computer but NOT on a free host (the disk is wiped on
// every spin-down).
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 8787;
const FILE = path.join(__dirname, 'saves.json');
const URL_DB = process.env.DATABASE_URL || '';
// One Render service per world; each world keeps its own table in the same database.
const TABLE = 'brawl_saves' + (String(process.env.WORLD || '').toLowerCase().replace(/[^a-z0-9]/g, '') ? '_' + String(process.env.WORLD).toLowerCase().replace(/[^a-z0-9]/g, '') : '');

let store;            // { get(u), put(u, acc) }
let mode = 'file';

function fileStore() {
  let DB = {};
  try { DB = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { DB = {}; }
  let dirty = false;
  setInterval(() => { if (dirty) { dirty = false; fs.writeFile(FILE, JSON.stringify(DB), () => {}); } }, 1000);
  return {
    count: async () => Object.keys(DB).length,
    get: async u => DB[u] || null,
    put: async (u, acc) => { DB[u] = acc; dirty = true; }
  };
}

async function pgStore() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: URL_DB,
    ssl: /localhost|127\.0\.0\.1/.test(URL_DB) ? false : { rejectUnauthorized: false }
  });
  await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    u text PRIMARY KEY, name text, h text, save jsonb, at bigint)`);
  return {
    count: async () => (await pool.query(`SELECT count(*) c FROM ${TABLE}`)).rows[0].c | 0,
    get: async u => {
      const r = await pool.query(`SELECT name, h, save, at FROM ${TABLE} WHERE u=$1`, [u]);
      if (!r.rows.length) return null;
      const x = r.rows[0];
      return { u: x.name, h: x.h, save: x.save, at: Number(x.at) };
    },
    put: async (u, acc) => {
      await pool.query(
        `INSERT INTO ${TABLE} (u, name, h, save, at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (u) DO UPDATE SET name=$2, h=$3, save=$4, at=$5`,
        [u, acc.u, acc.h, acc.save === undefined ? null : JSON.stringify(acc.save), acc.at]);
    }
  };
}

const key = u => String(u || '').trim().toLowerCase().slice(0, 12);
const send = (res, code, obj) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.url === '/health') {
    return store.count().then(n => send(res, 200, { ok: true, storage: mode, accounts: n }))
      .catch(e => send(res, 500, { error: String(e.message || e) }));
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

  let body = '';
  req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on('end', async () => {
    let m;
    try { m = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, { error: 'bad json' }); }
    const u = key(m.u), h = String(m.h || '');
    if (!u || !h) return send(res, 400, { error: 'missing account' });

    try {
      const acc = await store.get(u);

      if (req.url === '/register') {
        if (acc) return send(res, 409, { error: 'That username is taken.' });
        await store.put(u, { u: String(m.u).slice(0, 12), h, save: null, at: Date.now() });
        return send(res, 200, { ok: true, save: null });
      }
      if (!acc) return send(res, 404, { error: 'No account with that name on this server.' });
      if (acc.h !== h) return send(res, 403, { error: 'Wrong password.' });

      if (req.url === '/login') return send(res, 200, { ok: true, save: acc.save, at: acc.at });
      if (req.url === '/password') {
        const nh = String(m.nh || '');
        if (!nh) return send(res, 400, { error: 'missing new password' });
        acc.h = nh; acc.at = Date.now(); await store.put(u, acc);
        return send(res, 200, { ok: true });
      }
      if (req.url === '/save') {
        acc.save = m.save || null; acc.at = Date.now(); await store.put(u, acc);
        return send(res, 200, { ok: true, at: acc.at });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
  });
});

(async () => {
  if (URL_DB) {
    try { store = await pgStore(); mode = 'postgres'; }
    catch (e) { console.log('Postgres failed (' + e.message + '), falling back to a file'); store = fileStore(); }
  } else store = fileStore();
  server.listen(PORT, () => console.log('Brawl Arena save server on :' + PORT + ' (world ' + (process.env.WORLD || 'A') + ', saving to ' + mode + (mode === 'postgres' ? ' table ' + TABLE : '') + ')'));
})();
