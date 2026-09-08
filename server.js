'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { buildXlsx } = require('./xlsx');
const COMPANIES = require('./companies');

const PORT = process.env.PORT || 4321;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- simple session tokens for admin ----
const sessions = new Set();
function newToken() { const t = crypto.randomBytes(24).toString('hex'); sessions.add(t); return t; }
function getAdminPass() { return db.prepare('SELECT value FROM settings WHERE key=?').get('admin_password').value; }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json'
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}
function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = []; let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 20 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; }

function isAuthed(req) {
  const auth = req.headers['authorization'] || '';
  const tok = auth.replace(/^Bearer\s+/i, '');
  return sessions.has(tok);
}

// ---- survey serialization ----
function getSurveyBySlug(slug) {
  const s = db.prepare('SELECT * FROM surveys WHERE slug=?').get(slug);
  if (!s) return null;
  s.questions = db.prepare('SELECT * FROM questions WHERE survey_id=? ORDER BY ord,id').all(s.id)
    .map(q => ({ ...q, options: JSON.parse(q.options || '[]'), required: !!q.required }));
  return s;
}
function getSurveyById(id) {
  const s = db.prepare('SELECT * FROM surveys WHERE id=?').get(id);
  if (!s) return null;
  s.questions = db.prepare('SELECT * FROM questions WHERE survey_id=? ORDER BY ord,id').all(s.id)
    .map(q => ({ ...q, options: JSON.parse(q.options || '[]'), required: !!q.required }));
  return s;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = decodeURIComponent(url.pathname);
    const method = req.method;

    // ---------- API ----------
    if (p.startsWith('/api/')) {
      // --- Admin login ---
      if (p === '/api/admin/login' && method === 'POST') {
        const b = await readJson(req);
        if (b.password && b.password === getAdminPass()) return sendJson(res, 200, { token: newToken() });
        return sendJson(res, 401, { error: 'كلمة المرور غير صحيحة' });
      }

      // --- Public: list ASAP companies (brand registry) ---
      if (p === '/api/companies' && method === 'GET') {
        return sendJson(res, 200, COMPANIES);
      }

      // --- Public: get survey by slug ---
      let m;
      if ((m = p.match(/^\/api\/survey\/([^/]+)$/)) && method === 'GET') {
        const s = getSurveyBySlug(m[1]);
        if (!s || !s.published) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, s);
      }

      // --- Public: submit response ---
      if ((m = p.match(/^\/api\/survey\/([^/]+)\/submit$/)) && method === 'POST') {
        const s = getSurveyBySlug(m[1]);
        if (!s || !s.published) return sendJson(res, 404, { error: 'not found' });
        const b = await readJson(req);
        const data = b.data || {};
        // validate required
        for (const q of s.questions) {
          if (q.type === 'section') continue;
          if (q.required) {
            const v = data[q.id];
            if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) {
              return sendJson(res, 400, { error: `السؤال مطلوب: ${q.label}` });
            }
          }
        }
        db.prepare('INSERT INTO responses (survey_id,data) VALUES (?,?)').run(s.id, JSON.stringify(data));
        return sendJson(res, 200, { ok: true });
      }

      // ---- everything below requires auth ----
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });

      // list surveys
      if (p === '/api/admin/surveys' && method === 'GET') {
        const list = db.prepare('SELECT s.*, (SELECT COUNT(*) FROM responses r WHERE r.survey_id=s.id) AS responses FROM surveys s ORDER BY s.id DESC').all();
        return sendJson(res, 200, list);
      }
      // create survey
      if (p === '/api/admin/surveys' && method === 'POST') {
        const b = await readJson(req);
        let slug = (b.slug || '').trim() || 'survey-' + crypto.randomBytes(3).toString('hex');
        slug = slug.replace(/[^a-zA-Z0-9\-_]/g, '-').toLowerCase();
        // ensure unique
        let base = slug, n = 1;
        while (db.prepare('SELECT 1 FROM surveys WHERE slug=?').get(slug)) slug = base + '-' + (++n);
        const comp = COMPANIES.find(c => c.key === b.company) || COMPANIES[2];
        const info = db.prepare(`INSERT INTO surveys (slug,title,intro,logo,color_primary,color_accent,company,hero_title,thanks,published)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          slug, b.title || 'استبيان جديد', b.intro || '', b.logo || comp.logo,
          b.color_primary || comp.color_primary, b.color_accent || comp.color_accent, comp.key,
          b.hero_title || '', b.thanks || 'شكرًا لمشاركتكم.', b.published === false ? 0 : 1);
        return sendJson(res, 200, getSurveyById(Number(info.lastInsertRowid)));
      }
      // get one survey (admin)
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)$/)) && method === 'GET') {
        const s = getSurveyById(Number(m[1]));
        if (!s) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, s);
      }
      // update survey meta + questions (full replace of questions)
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)$/)) && method === 'PUT') {
        const id = Number(m[1]);
        const s = db.prepare('SELECT * FROM surveys WHERE id=?').get(id);
        if (!s) return sendJson(res, 404, { error: 'not found' });
        const b = await readJson(req);
        let slug = s.slug;
        if (b.slug && b.slug !== s.slug) {
          slug = b.slug.replace(/[^a-zA-Z0-9\-_]/g, '-').toLowerCase();
          let base = slug, n = 1;
          while (db.prepare('SELECT 1 FROM surveys WHERE slug=? AND id<>?').get(slug, id)) slug = base + '-' + (++n);
        }
        db.prepare(`UPDATE surveys SET slug=?,title=?,intro=?,logo=?,color_primary=?,color_accent=?,company=?,hero_title=?,thanks=?,published=? WHERE id=?`).run(
          slug, b.title ?? s.title, b.intro ?? s.intro, b.logo ?? s.logo,
          b.color_primary ?? s.color_primary, b.color_accent ?? s.color_accent,
          b.company ?? s.company, b.hero_title ?? s.hero_title, b.thanks ?? s.thanks,
          b.published === false ? 0 : (b.published === true ? 1 : s.published), id);
        if (Array.isArray(b.questions)) {
          db.prepare('DELETE FROM questions WHERE survey_id=?').run(id);
          const ins = db.prepare(`INSERT INTO questions (survey_id,ord,label,help,type,required,options,max_select,scale_min,scale_max)
            VALUES (?,?,?,?,?,?,?,?,?,?)`);
          b.questions.forEach((q, i) => {
            ins.run(id, i, q.label || '', q.help || '', q.type || 'text',
              q.required ? 1 : 0, JSON.stringify(q.options || []),
              q.max_select || 0, q.scale_min || 1, q.scale_max || 5);
          });
        }
        return sendJson(res, 200, getSurveyById(id));
      }
      // delete survey
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)$/)) && method === 'DELETE') {
        db.prepare('DELETE FROM responses WHERE survey_id=?').run(Number(m[1]));
        db.prepare('DELETE FROM questions WHERE survey_id=?').run(Number(m[1]));
        db.prepare('DELETE FROM surveys WHERE id=?').run(Number(m[1]));
        return sendJson(res, 200, { ok: true });
      }
      // responses (admin)
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)\/responses$/)) && method === 'GET') {
        const rows = db.prepare('SELECT * FROM responses WHERE survey_id=? ORDER BY id DESC').all(Number(m[1]))
          .map(r => ({ id: r.id, created_at: r.created_at, data: JSON.parse(r.data) }));
        return sendJson(res, 200, rows);
      }
      // export xlsx
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)\/export$/)) && method === 'GET') {
        const s = getSurveyById(Number(m[1]));
        if (!s) return sendJson(res, 404, { error: 'not found' });
        const qs = s.questions.filter(q => q.type !== 'section');
        const header = ['#', 'التاريخ', ...qs.map(q => q.label)];
        const responses = db.prepare('SELECT * FROM responses WHERE survey_id=? ORDER BY id').all(s.id);
        const rows = [header];
        responses.forEach((r, i) => {
          const d = JSON.parse(r.data);
          const row = [i + 1, r.created_at];
          for (const q of qs) {
            let v = d[q.id];
            if (Array.isArray(v)) v = v.join(' | ');
            row.push(v == null ? '' : v);
          }
          rows.push(row);
        });
        const buf = buildXlsx(rows);
        const fname = encodeURIComponent(`${s.slug || 'survey'}-responses.xlsx`);
        return send(res, 200, buf, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${fname}"; filename*=UTF-8''${fname}`
        });
      }
      // upload image (logo) -> base64 data URL stored inline
      if (p === '/api/admin/upload' && method === 'POST') {
        const ct = req.headers['content-type'] || '';
        const body = await readBody(req);
        const ext = (ct.split('/')[1] || 'png').split(';')[0];
        const fname = crypto.randomBytes(8).toString('hex') + '.' + ext.replace(/[^a-z0-9]/gi, '');
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), body);
        return sendJson(res, 200, { url: '/uploads/' + fname });
      }
      // change admin password
      if (p === '/api/admin/password' && method === 'POST') {
        const b = await readJson(req);
        if (!b.password || b.password.length < 4) return sendJson(res, 400, { error: 'كلمة مرور قصيرة' });
        db.prepare('UPDATE settings SET value=? WHERE key=?').run(b.password, 'admin_password');
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'no route' });
    }

    // ---------- uploads ----------
    if (p.startsWith('/uploads/')) {
      const f = path.join(UPLOAD_DIR, path.basename(p));
      if (fs.existsSync(f)) {
        const ext = path.extname(f).toLowerCase();
        return send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      }
      return send(res, 404, 'not found');
    }

    // ---------- admin app ----------
    if (p === '/admin' || p.startsWith('/admin/')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html')), { 'Content-Type': MIME['.html'] });
    }

    // ---------- survey page ----------
    if (p.startsWith('/s/')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'survey.html')), { 'Content-Type': MIME['.html'] });
    }

    // ---------- static ----------
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full).toLowerCase();
      return send(res, 200, fs.readFileSync(full), { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    }

    return send(res, 404, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), { 'Content-Type': MIME['.html'] });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`Survey platform running on http://localhost:${PORT}`));
