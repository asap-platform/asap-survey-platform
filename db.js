'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// DATA_DIR is configurable so it can point at a persistent volume (Railway).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'surveys.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  intro TEXT DEFAULT '',
  logo TEXT DEFAULT '',
  color_primary TEXT DEFAULT '#7B2E8E',
  color_accent TEXT DEFAULT '#29ABE2',
  company TEXT DEFAULT 'legaltech',
  hero_title TEXT DEFAULT '',
  thanks TEXT DEFAULT 'شكرًا لمشاركتكم.',
  published INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  ord INTEGER DEFAULT 0,
  label TEXT NOT NULL,
  help TEXT DEFAULT '',
  type TEXT NOT NULL,           -- text, textarea, number, phone, email, single, multi, scale, section
  required INTEGER DEFAULT 0,
  options TEXT DEFAULT '[]',    -- JSON array (for single/multi)
  max_select INTEGER DEFAULT 0, -- for multi (0 = unlimited)
  scale_min INTEGER DEFAULT 1,
  scale_max INTEGER DEFAULT 5,
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  data TEXT NOT NULL,           -- JSON { questionId: value }
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  pass_hash TEXT DEFAULT '',      -- scrypt hash (empty until invite accepted)
  role TEXT DEFAULT 'creator',    -- owner | creator
  status TEXT DEFAULT 'invited',  -- invited | active | disabled
  invite_token TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
-- co-owners: additional users who can view/edit a survey (beyond surveys.owner_id)
CREATE TABLE IF NOT EXISTS survey_owners (
  survey_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (survey_id, user_id)
);
`);

const crypto = require('node:crypto');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + dk;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, dk] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(dk, 'hex'), Buffer.from(test, 'hex')); }
  catch { return false; }
}

// migration: add company column if missing (for older DBs)
try {
  const cols = db.prepare("PRAGMA table_info(surveys)").all().map(c => c.name);
  if (!cols.includes('company')) db.exec("ALTER TABLE surveys ADD COLUMN company TEXT DEFAULT 'legaltech'");
  if (!cols.includes('owner_id')) db.exec("ALTER TABLE surveys ADD COLUMN owner_id INTEGER DEFAULT 0");
} catch (e) {}

// default admin password (legacy fallback login)
const row = db.prepare('SELECT value FROM settings WHERE key=?').get('admin_password');
if (!row) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('admin_password', 'asap2026');
}

// seed the owner account (Ayman) — created once, credentials from env or defaults
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'ayman@asap.sa').toLowerCase();
const OWNER_PASS = process.env.OWNER_PASS || 'Asap@6497868';
const owner = db.prepare('SELECT id FROM users WHERE email=?').get(OWNER_EMAIL);
if (!owner) {
  db.prepare(`INSERT INTO users (email,name,pass_hash,role,status) VALUES (?,?,?,?,?)`)
    .run(OWNER_EMAIL, 'أيمن السهيان', hashPassword(OWNER_PASS), 'owner', 'active');
  // assign any existing (pre-accounts) surveys to the owner
  const ownerId = db.prepare('SELECT id FROM users WHERE email=?').get(OWNER_EMAIL).id;
  db.prepare('UPDATE surveys SET owner_id=? WHERE owner_id=0 OR owner_id IS NULL').run(ownerId);
}

module.exports = db;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
