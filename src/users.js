// Team accounts: users, roles, invite links and password resets.
// Passwords use scrypt with a per-user salt; invite/reset tokens are stored hashed.
const crypto = require('crypto');
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rep',          -- admin | rep
  password_hash TEXT NOT NULL,
  disabled INTEGER DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'invite',       -- invite | reset
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT 'rep',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT DEFAULT '',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// admin: everything · operator: whole pipeline + routing, no users/settings · manager: one branch only · rep: works leads
const ROLES = ['admin', 'operator', 'manager', 'rep'];
try { db.exec('ALTER TABLE users ADD COLUMN branch TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE invites ADD COLUMN branch TEXT'); } catch { /* exists */ }
const { getSettings } = require('./db');
function checkRole(role, branch) {
  if (!ROLES.includes(role)) throw err('Role must be admin, operator, manager or rep');
  if (role !== 'manager') return null;
  const b = (getSettings().branches || []).find(x => x.toLowerCase() === String(branch || '').toLowerCase());
  if (!b) throw err('Pick which branch this manager runs');
  return b;
}
const INVITE_DAYS = 7;
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return test.length === want.length && crypto.timingSafeEqual(test, want);
}
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw err('Password must be at least 10 characters');
}

const PUBLIC_COLS = 'id, email, name, role, branch, disabled, last_login_at, created_at';
function get(id) { return db.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`).get(id); }
function list() { return db.prepare(`SELECT ${PUBLIC_COLS} FROM users ORDER BY disabled, name`).all(); }
function names() { return db.prepare('SELECT name FROM users WHERE disabled = 0 ORDER BY name').all().map(r => r.name); }

function authenticate(email, password) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  // Run a hash even for unknown emails so timing doesn't reveal which emails exist.
  if (!u) { checkPassword(password, 'scrypt$00$00'); return null; }
  if (u.disabled || !checkPassword(password, u.password_hash)) return null;
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(u.id);
  return get(u.id);
}

function createInvite({ email, role = 'rep', branch }, by = '') {
  email = String(email || '').trim().toLowerCase();
  if (!isEmail(email)) throw err('Enter a valid email address');
  branch = checkRole(role, branch);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw err('That person already has an account. Use "Reset password" instead.', 409);
  // One live invite per email: replace any older pending one.
  db.prepare("DELETE FROM invites WHERE email = ? AND kind = 'invite' AND used_at IS NULL").run(email);
  return issue({ kind: 'invite', email, role, branch, by });
}
function createReset(userId, by = '') {
  const u = get(userId);
  if (!u) throw err('User not found', 404);
  db.prepare("DELETE FROM invites WHERE user_id = ? AND kind = 'reset' AND used_at IS NULL").run(u.id);
  return issue({ kind: 'reset', email: u.email, role: u.role, userId: u.id, by });
}
function issue({ kind, email, role, branch = null, userId = null, by }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO invites (token_hash, kind, email, role, branch, user_id, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha(token), kind, email, role, branch, userId, by, expires);
  return { token, email, role, branch, kind, expires_at: expires };
}

function findInvite(token) {
  const inv = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha(String(token || '')));
  if (!inv) return { error: 'This link is not valid.' };
  if (inv.used_at) return { error: 'This link has already been used.' };
  if (inv.expires_at < new Date().toISOString().replace('T', ' ').slice(0, 19)) return { error: 'This link has expired. Ask an admin for a new one.' };
  return { invite: inv };
}

function acceptInvite(token, { name, password }) {
  const { invite, error } = findInvite(token);
  if (error) throw err(error, 410);
  validatePassword(password);
  let userId;
  if (invite.kind === 'reset') {
    db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?').run(hashPassword(password), invite.user_id);
    userId = invite.user_id;
  } else {
    name = String(name || '').trim();
    if (!name) throw err('Enter your name');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(invite.email)) throw err('An account already exists for this email', 409);
    userId = Number(db.prepare('INSERT INTO users (email, name, role, branch, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(invite.email, name, invite.role, invite.role === 'manager' ? invite.branch : null, hashPassword(password)).lastInsertRowid);
  }
  db.prepare("UPDATE invites SET used_at = datetime('now') WHERE id = ?").run(invite.id);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  return get(userId);
}

function pendingInvites() {
  return db.prepare(`SELECT id, kind, email, role, branch, invited_by, expires_at, created_at FROM invites
    WHERE used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC`).all();
}
function revokeInvite(id) { db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').run(id); }

function update(id, { name, role, branch, disabled }) {
  const u = get(id);
  if (!u) return null;
  let newBranch = u.branch;
  if (role !== undefined || branch !== undefined) {
    const r = role ?? u.role;
    newBranch = checkRole(r, branch ?? u.branch);
  }
  if (name !== undefined && !String(name).trim()) throw err('Name cannot be empty');
  db.prepare('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), branch = ?, disabled = COALESCE(?, disabled) WHERE id = ?')
    .run(name === undefined ? null : String(name).trim(), role ?? null, newBranch, disabled === undefined ? null : (disabled ? 1 : 0), id);
  return get(id);
}
function remove(id) { db.prepare('DELETE FROM users WHERE id = ?').run(id); }

module.exports = { ROLES, INVITE_DAYS, get, list, names, authenticate, createInvite, createReset, findInvite, acceptInvite, pendingInvites, revokeInvite, update, remove, hashPassword, checkPassword };
