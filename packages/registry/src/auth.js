import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken() {
  return 'bvr_' + randomBytes(24).toString('base64url');
}

export class Auth {
  constructor(db, { adminUsers = [] } = {}) {
    this.db = db;
    this.adminUsers = new Set(adminUsers);
    this.promoteAdmins();
  }

  /* ADMIN_USERS names administrators whether their account predates the
   * setting or not: an account created before (e.g. at a first single sign-on)
   * is promoted when the registry starts. Accounts are never demoted here. */
  promoteAdmins() {
    const set = this.db.prepare("UPDATE users SET role = 'admin' WHERE name = ? AND role != 'admin'");
    const promoted = [];
    for (const name of this.adminUsers) if (set.run(name).changes) promoted.push(name);
    return promoted;
  }

  addAdmin(name) {
    this.adminUsers.add(name);
    this.promoteAdmins();
  }

  isAdmin(user) {
    return !!user && (user.role === 'admin' || this.adminUsers.has(user.name));
  }

  userCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  roleFor(name) {
    // The very first account and any name listed in ADMIN_USERS become admins.
    return this.adminUsers.has(name) || this.userCount() === 0 ? 'admin' : 'user';
  }

  createUser({ name, email = null, password = null, oidcSub = null }) {
    const role = this.roleFor(name);
    const password_hash = password ? hashPassword(password) : null;
    this.db.prepare('INSERT INTO users (name, email, password_hash, oidc_sub, role) VALUES (?, ?, ?, ?, ?)').run(name, email, password_hash, oidcSub, role);
    return this.getUser(name);
  }

  getUser(name) {
    return this.db.prepare('SELECT id, name, email, role, oidc_sub, created_at FROM users WHERE name = ?').get(name) ?? null;
  }

  getUserByOidc(sub) {
    return this.db.prepare('SELECT id, name, email, role, oidc_sub, created_at FROM users WHERE oidc_sub = ?').get(sub) ?? null;
  }

  // Finds or creates the local account backing an OIDC identity.
  upsertOidcUser({ sub, preferredName, email }) {
    let user = this.getUserByOidc(sub);
    if (user) return user;
    let name = (preferredName || email?.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const existing = this.getUser(name);
    if (existing && !existing.oidc_sub) {
      // Same username exists as a local account: link it to the OIDC identity.
      this.db.prepare('UPDATE users SET oidc_sub = ?, email = COALESCE(email, ?) WHERE id = ?').run(sub, email, existing.id);
      return this.getUser(name);
    }
    if (existing) name = `${name}-${sub.slice(0, 6)}`;
    return this.createUser({ name, email, oidcSub: sub });
  }

  login(name, password) {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE name = ?').get(name);
    if (!row || !verifyPassword(password, row.password_hash)) return null;
    return this.getUser(name);
  }

  createToken(userId, label = null) {
    const token = newToken();
    this.db.prepare('INSERT INTO tokens (user_id, token_hash, label) VALUES (?, ?, ?)').run(userId, hashToken(token), label);
    return token;
  }

  userForToken(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT u.id, u.name, u.email, u.role, t.id AS token_id FROM tokens t
      JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`).get(hashToken(token));
    if (!row) return null;
    this.db.prepare("UPDATE tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.token_id);
    return row;
  }

  revokeToken(token) {
    return this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(hashToken(token)).changes > 0;
  }

  listTokens(userId) {
    return this.db.prepare('SELECT id, label, created_at, last_used_at FROM tokens WHERE user_id = ?').all(userId);
  }
}
