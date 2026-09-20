// OpenID Connect authorization-code flow (with PKCE) used by `bevara login`
// when the registry is configured against an identity provider such as
// Casdoor. The CLI opens `/-/login/web?callback=http://127.0.0.1:<port>/…`,
// the browser round-trips through the IdP, and the registry finally redirects
// to the callback with a freshly minted API token.
import { createHash, randomBytes } from 'node:crypto';

export class Oidc {
  constructor({ issuer, clientId, clientSecret, publicUrl, scope = 'openid profile email' }) {
    this.issuer = issuer.replace(/\/$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.publicUrl = publicUrl.replace(/\/$/, '');
    this.scope = scope;
    this.pending = new Map(); // state -> { verifier, callback, expires }
    this.discovery = null;
  }

  get redirectUri() { return `${this.publicUrl}/-/login/web/callback`; }

  async config() {
    if (this.discovery) return this.discovery;
    const res = await fetch(`${this.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    this.discovery = await res.json();
    return this.discovery;
  }

  gc() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
  }

  async authorizationUrl(callback) {
    this.gc();
    const cfg = await this.config();
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { verifier, callback, expires: Date.now() + 10 * 60_000 });
    const u = new URL(cfg.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('scope', this.scope);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async exchange(code, state) {
    const p = this.pending.get(state);
    if (!p || p.expires < Date.now()) throw new Error('unknown or expired login state');
    this.pending.delete(state);
    const cfg = await this.config();
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: this.redirectUri,
      client_id: this.clientId, client_secret: this.clientSecret, code_verifier: p.verifier,
    });
    const res = await fetch(cfg.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
    const tokens = await res.json();
    let claims = {};
    if (cfg.userinfo_endpoint && tokens.access_token) {
      const ui = await fetch(cfg.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } });
      if (ui.ok) claims = await ui.json();
    }
    if (!claims.sub && tokens.id_token) claims = decodeJwtPayload(tokens.id_token);
    if (!claims.sub) throw new Error('identity provider returned no subject');
    return {
      sub: claims.sub,
      preferredName: claims.preferred_username || claims.name || claims.displayName,
      email: claims.email,
      callback: p.callback,
    };
  }
}

function decodeJwtPayload(jwt) {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
