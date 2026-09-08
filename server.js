'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { buildXlsx } = require('./xlsx');
const COMPANIES = require('./companies');
const { maybeSendInvite } = require('./mailer');

const PORT = process.env.PORT || 4321;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.env.DATA_DIR || __dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- session tokens -> userId ----
const sessions = new Map(); // token -> userId
function newToken(userId) { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, userId); return t; }
function getAdminPass() { return db.prepare('SELECT value FROM settings WHERE key=?').get('admin_password').value; }
function currentUser(req) {
  const auth = req.headers['authorization'] || '';
  const tok = auth.replace(/^Bearer\s+/i, '');
  const uid = sessions.get(tok);
  if (!uid) return null;
  return db.prepare('SELECT id,email,name,role,status FROM users WHERE id=?').get(uid) || null;
}

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

function isAuthed(req) { return !!currentUser(req); }

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
      // --- Admin login (email + password) ---
      if (p === '/api/admin/login' && method === 'POST') {
        const b = await readJson(req);
        const email = (b.email || '').trim().toLowerCase();
        // email + password login
        if (email && b.password) {
          const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
          if (u && u.status === 'active' && db.verifyPassword(b.password, u.pass_hash)) {
            return sendJson(res, 200, { token: newToken(u.id), user: { email: u.email, name: u.name, role: u.role } });
          }
          return sendJson(res, 401, { error: 'البريد أو كلمة المرور غير صحيحة' });
        }
        // legacy: password-only (maps to owner) — kept for backward compatibility
        if (b.password && b.password === getAdminPass()) {
          const owner = db.prepare("SELECT * FROM users WHERE role='owner' ORDER BY id LIMIT 1").get();
          if (owner) return sendJson(res, 200, { token: newToken(owner.id), user: { email: owner.email, name: owner.name, role: owner.role } });
        }
        return sendJson(res, 401, { error: 'البريد أو كلمة المرور غير صحيحة' });
      }

      // --- Public: accept invite (set password) ---
      let mm;
      if (p === '/api/invite/accept' && method === 'POST') {
        const b = await readJson(req);
        const u = db.prepare('SELECT * FROM users WHERE invite_token=? AND status=?').get(b.token || '', 'invited');
        if (!u || !b.token) return sendJson(res, 400, { error: 'رابط الدعوة غير صالح أو مستخدم' });
        if (!b.password || b.password.length < 6) return sendJson(res, 400, { error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
        db.prepare('UPDATE users SET pass_hash=?, status=?, name=?, invite_token=? WHERE id=?')
          .run(db.hashPassword(b.password), 'active', b.name || u.name, '', u.id);
        return sendJson(res, 200, { token: newToken(u.id), user: { email: u.email, name: b.name || u.name, role: u.role } });
      }
      // --- Public: get invite info (to show email on accept page) ---
      if (p === '/api/invite/info' && method === 'GET') {
        const t = url.searchParams.get('token') || '';
        const u = db.prepare('SELECT email,name,status FROM users WHERE invite_token=?').get(t);
        if (!u || u.status !== 'invited') return sendJson(res, 404, { error: 'رابط الدعوة غير صالح' });
        return sendJson(res, 200, { email: u.email, name: u.name });
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
      const me = currentUser(req);
      if (!me) return sendJson(res, 401, { error: 'unauthorized' });
      const isOwner = me.role === 'owner';
      const isCoOwner = (sid) => !!db.prepare('SELECT 1 FROM survey_owners WHERE survey_id=? AND user_id=?').get(Number(sid), me.id);
      // returns the survey row if the user may access it; null if not found; false if forbidden
      const accessibleSurvey = (id) => {
        const s = db.prepare('SELECT * FROM surveys WHERE id=?').get(Number(id));
        if (!s) return null;
        if (isOwner || s.owner_id === me.id || isCoOwner(id)) return s;
        return false; // exists but forbidden
      };

      // list surveys (site owner sees all; others see owned + co-owned)
      if (p === '/api/admin/surveys' && method === 'GET') {
        const sql = 'SELECT s.*, (SELECT COUNT(*) FROM responses r WHERE r.survey_id=s.id) AS responses, u.email AS owner_email FROM surveys s LEFT JOIN users u ON u.id=s.owner_id';
        const list = isOwner
          ? db.prepare(sql + ' ORDER BY s.id DESC').all()
          : db.prepare(sql + ' WHERE s.owner_id=? OR s.id IN (SELECT survey_id FROM survey_owners WHERE user_id=?) ORDER BY s.id DESC').all(me.id, me.id);
        return sendJson(res, 200, list);
      }
      // create survey (owned by current user)
      if (p === '/api/admin/surveys' && method === 'POST') {
        const b = await readJson(req);
        let slug = (b.slug || '').trim() || 'survey-' + crypto.randomBytes(3).toString('hex');
        slug = slug.replace(/[^a-zA-Z0-9\-_]/g, '-').toLowerCase();
        // ensure unique
        let base = slug, n = 1;
        while (db.prepare('SELECT 1 FROM surveys WHERE slug=?').get(slug)) slug = base + '-' + (++n);
        const comp = COMPANIES.find(c => c.key === b.company) || COMPANIES[2];
        const info = db.prepare(`INSERT INTO surveys (slug,title,intro,logo,color_primary,color_accent,company,hero_title,thanks,published,owner_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          slug, b.title || 'استبيان جديد', b.intro || '', b.logo || comp.logo,
          b.color_primary || comp.color_primary, b.color_accent || comp.color_accent, comp.key,
          b.hero_title || '', b.thanks || 'شكرًا لمشاركتكم.', b.published === false ? 0 : 1, me.id);
        return sendJson(res, 200, getSurveyById(Number(info.lastInsertRowid)));
      }

      // ---- user management (owner only) ----
      if (p === '/api/admin/users' && method === 'GET') {
        if (!isOwner) return sendJson(res, 403, { error: 'صلاحية المالك فقط' });
        const users = db.prepare('SELECT id,email,name,role,status FROM users ORDER BY id').all()
          .map(u => ({ ...u, surveys: db.prepare('SELECT COUNT(*) c FROM surveys WHERE owner_id=?').get(u.id).c }));
        return sendJson(res, 200, users);
      }
      if (p === '/api/admin/users' && method === 'POST') {
        if (!isOwner) return sendJson(res, 403, { error: 'صلاحية المالك فقط' });
        const b = await readJson(req);
        const email = (b.email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'بريد غير صحيح' });
        if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return sendJson(res, 400, { error: 'البريد مسجّل مسبقًا' });
        const token = crypto.randomBytes(24).toString('hex');
        db.prepare('INSERT INTO users (email,name,role,status,invite_token) VALUES (?,?,?,?,?)')
          .run(email, b.name || '', 'creator', 'invited', token);
        const base = process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
        const link = `${base}/invite?token=${token}`;
        const emailed = await maybeSendInvite(email, link).catch(() => false);
        return sendJson(res, 200, { ok: true, invite_link: link, emailed });
      }
      // resend/regenerate invite
      if ((m = p.match(/^\/api\/admin\/users\/(\d+)\/invite$/)) && method === 'POST') {
        if (!isOwner) return sendJson(res, 403, { error: 'صلاحية المالك فقط' });
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(m[1]));
        if (!u) return sendJson(res, 404, { error: 'not found' });
        const token = crypto.randomBytes(24).toString('hex');
        db.prepare('UPDATE users SET invite_token=?, status=? WHERE id=?').run(token, u.status === 'active' ? 'active' : 'invited', u.id);
        const base = process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
        const link = `${base}/invite?token=${token}`;
        const emailed = await maybeSendInvite(u.email, link).catch(() => false);
        return sendJson(res, 200, { ok: true, invite_link: link, emailed });
      }
      if ((m = p.match(/^\/api\/admin\/users\/(\d+)$/)) && method === 'DELETE') {
        if (!isOwner) return sendJson(res, 403, { error: 'صلاحية المالك فقط' });
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(m[1]));
        if (!u) return sendJson(res, 404, { error: 'not found' });
        if (u.role === 'owner') return sendJson(res, 400, { error: 'لا يمكن حذف حساب المالك' });
        db.prepare('DELETE FROM users WHERE id=?').run(u.id);
        return sendJson(res, 200, { ok: true });
      }

      // who am I
      if (p === '/api/admin/me' && method === 'GET') {
        return sendJson(res, 200, { email: me.email, name: me.name, role: me.role });
      }

      // ---- survey co-owners (managers) ----
      // list co-owners of a survey
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)\/owners$/)) && method === 'GET') {
        const acc = accessibleSurvey(m[1]);
        if (acc === null) return sendJson(res, 404, { error: 'not found' });
        if (acc === false) return sendJson(res, 403, { error: 'ليس لديك صلاحية على هذا الاستبيان' });
        const primary = db.prepare('SELECT id,email,name FROM users WHERE id=?').get(acc.owner_id);
        const cos = db.prepare('SELECT u.id,u.email,u.name,u.status FROM survey_owners so JOIN users u ON u.id=so.user_id WHERE so.survey_id=?').all(Number(m[1]));
        return sendJson(res, 200, { primary: primary || null, coOwners: cos });
      }
      // add a co-owner by email (creates an invited user if not present)
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)\/owners$/)) && method === 'POST') {
        const acc = accessibleSurvey(m[1]);
        if (acc === null) return sendJson(res, 404, { error: 'not found' });
        if (acc === false) return sendJson(res, 403, { error: 'ليس لديك صلاحية على هذا الاستبيان' });
        const b = await readJson(req);
        const email = (b.email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'بريد غير صحيح' });
        let u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        let invite_link = null;
        if (!u) {
          const token = crypto.randomBytes(24).toString('hex');
          db.prepare('INSERT INTO users (email,name,role,status,invite_token) VALUES (?,?,?,?,?)')
            .run(email, b.name || '', 'creator', 'invited', token);
          u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
          const base = process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
          invite_link = `${base}/invite?token=${token}`;
        }
        if (u.id === acc.owner_id) return sendJson(res, 400, { error: 'هذا المستخدم هو المالك الأساسي بالفعل' });
        db.prepare('INSERT OR IGNORE INTO survey_owners (survey_id,user_id) VALUES (?,?)').run(Number(m[1]), u.id);
        // email invite if configured
        let emailed = false;
        if (invite_link) { emailed = await maybeSendInvite(email, invite_link).catch(() => false); }
        return sendJson(res, 200, { ok: true, invite_link, emailed, isNew: !!invite_link });
      }
      // remove a co-owner
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)\/owners\/(\d+)$/)) && method === 'DELETE') {
        const acc = accessibleSurvey(m[1]);
        if (acc === null) return sendJson(res, 404, { error: 'not found' });
        if (acc === false) return sendJson(res, 403, { error: 'ليس لديك صلاحية على هذا الاستبيان' });
        db.prepare('DELETE FROM survey_owners WHERE survey_id=? AND user_id=?').run(Number(m[1]), Number(m[2]));
        return sendJson(res, 200, { ok: true });
      }
      // transfer primary ownership to a user (owner or current primary only)
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)\/transfer$/)) && method === 'POST') {
        const acc = accessibleSurvey(m[1]);
        if (acc === null) return sendJson(res, 404, { error: 'not found' });
        if (acc === false) return sendJson(res, 403, { error: 'ليس لديك صلاحية على هذا الاستبيان' });
        if (!isOwner && acc.owner_id !== me.id) return sendJson(res, 403, { error: 'المالك الأساسي أو مالك المنصة فقط يمكنه النقل' });
        const b = await readJson(req);
        const target = db.prepare('SELECT * FROM users WHERE id=?').get(Number(b.userId));
        if (!target) return sendJson(res, 400, { error: 'المستخدم غير موجود' });
        db.prepare('UPDATE surveys SET owner_id=? WHERE id=?').run(target.id, Number(m[1]));
        db.prepare('DELETE FROM survey_owners WHERE survey_id=? AND user_id=?').run(Number(m[1]), target.id);
        return sendJson(res, 200, { ok: true });
      }

      // get one survey (admin) — ownership enforced
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)$/)) && method === 'GET') {
        const acc = accessibleSurvey(m[1]);
        if (acc === null) return sendJson(res, 404, { error: 'not found' });
        if (acc === false) return sendJson(res, 403, { error: 'ليس لديك صلاحية على هذا الاستبيان' });
        return sendJson(res, 200, getSurveyById(Number(m[1])));
      }
      // update survey meta + questions (full replace of questions)
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)$/)) && method === 'PUT') {
        const id = Number(m[1]);
        const acc = accessibleSurvey(id);
        if (acc === null) return sendJson(res, 404, { error: 'not found' });
        if (acc === false) return sendJson(res, 403, { error: 'ليس لديك صلاحية على هذا الاستبيان' });
        const s = acc;
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
      // delete survey (ownership enforced)
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)$/)) && method === 'DELETE') {
        const acc = accessibleSurvey(m[1]);
        if (acc === null) return sendJson(res, 404, { error: 'not found' });
        if (acc === false) return sendJson(res, 403, { error: 'ليس لديك صلاحية على هذا الاستبيان' });
        db.prepare('DELETE FROM responses WHERE survey_id=?').run(Number(m[1]));
        db.prepare('DELETE FROM questions WHERE survey_id=?').run(Number(m[1]));
        db.prepare('DELETE FROM surveys WHERE id=?').run(Number(m[1]));
        return sendJson(res, 200, { ok: true });
      }
      // responses (admin, ownership enforced)
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)\/responses$/)) && method === 'GET') {
        const acc = accessibleSurvey(m[1]);
        if (acc === null) return sendJson(res, 404, { error: 'not found' });
        if (acc === false) return sendJson(res, 403, { error: 'ليس لديك صلاحية على هذا الاستبيان' });
        const rows = db.prepare('SELECT * FROM responses WHERE survey_id=? ORDER BY id DESC').all(Number(m[1]))
          .map(r => ({ id: r.id, created_at: r.created_at, data: JSON.parse(r.data) }));
        return sendJson(res, 200, rows);
      }
      // export xlsx (ownership enforced)
      if ((m = p.match(/^\/api\/admin\/surveys\/(\d+)\/export$/)) && method === 'GET') {
        const acc = accessibleSurvey(m[1]);
        if (acc === null) return sendJson(res, 404, { error: 'not found' });
        if (acc === false) return sendJson(res, 403, { error: 'ليس لديك صلاحية على هذا الاستبيان' });
        const s = getSurveyById(Number(m[1]));
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
      // change MY password (current logged-in user)
      if (p === '/api/admin/password' && method === 'POST') {
        const b = await readJson(req);
        if (!b.password || b.password.length < 6) return sendJson(res, 400, { error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
        db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(db.hashPassword(b.password), me.id);
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

    // ---------- invite accept page ----------
    if (p === '/invite' || p.startsWith('/invite')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'invite.html')), { 'Content-Type': MIME['.html'] });
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
