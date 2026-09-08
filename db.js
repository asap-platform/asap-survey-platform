'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, 'data');
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
`);

// migration: add company column if missing (for older DBs)
try {
  const cols = db.prepare("PRAGMA table_info(surveys)").all().map(c => c.name);
  if (!cols.includes('company')) db.exec("ALTER TABLE surveys ADD COLUMN company TEXT DEFAULT 'legaltech'");
} catch (e) {}

// default admin password
const row = db.prepare('SELECT value FROM settings WHERE key=?').get('admin_password');
if (!row) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('admin_password', 'asap2026');
}

module.exports = db;
