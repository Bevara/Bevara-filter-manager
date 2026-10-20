// OpenID Connect authorization-code flow (with PKCE) used by `bevara login`
// when the registry is configured against an identity provider such as
// Casdoor. The CLI opens `/-/login/web?callback=http://127.0.0.1:<port>/…`,
// the browser round-trips through the IdP, and the registry finally redirects
// to the callback with a freshly minted API token.
import { constants, createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

// JWS algorithms accepted on access tokens (never "none" nor the HMAC ones).
const JWS = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, PS384: { hash: 'sha384', pss: true }, PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
};
const CLOCK_SKEW = 60; // seconds

export class Oidc {
  constructor({ issuer, clientId, clientSecret, publicUrl, scope = 'openid profile email', fetch: fetchImpl = globalThis.fetch }) {
    this.issuer = issuer.replace(/\/$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.publicUrl = publicUrl.replace(/\/$/, '');
    this.scope = scope;
    this.pending = new Map(); // state -> { verifier, callback, expires }
    this.discovery = null;
    this.fetch = fetchImpl;
    this.jwks = null;         // { keys: Map kid -> KeyObject, fetchedAt }
  }

  get redirectUri() { return `${this.publicUrl}/-/login/web/callback`; }

  async config() {
    if (this.discovery) return this.discovery;
    const res = await this.fetch(`${this.issuer}/.well-known/openid-configuration`);
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
    const res = await this.fetch(cfg.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
    const tokens = await res.json();
    let claims = {};
    if (cfg.userinfo_endpoint && tokens.access_token) {
      const ui = await this.fetch(cfg.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } });
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

  /* Access tokens the identity provider issued to other applications of ours
   * (the administrators' dashboard), checked offline: signature against the
   * provider's published keys, issuer, expiry, and an audience among those the
   * registry accepts. Returns the claims, or throws. */
  async verifyAccessToken(jwt, { audiences }) {
    const parts = String(jwt ?? '').split('.');
    if (parts.length !== 3) throw new Error('not a JWT');
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = decodeJwtPayload(jwt); } catch { throw new Error('malformed JWT'); }
    const alg = JWS[header.alg];
    if (!alg) throw new Error(`unsupported JWT algorithm ${header.alg}`);
    const key = await this.signingKey(header.kid);
    const opts = alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : alg.ec ? { key, dsaEncoding: 'ieee-p1363' } : key;
    if (!verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), opts, Buffer.from(parts[2], 'base64url'))) throw new Error('invalid JWT signature');
    const now = Math.floor(Date.now() / 1000);
    if (String(claims.iss ?? '').replace(/\/$/, '') !== this.issuer) throw new Error('JWT from another issuer');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW < now) throw new Error('JWT expired');
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW > now) throw new Error('JWT not yet valid');
    const aud = [claims.aud ?? []].flat();
    if (!aud.some((a) => audiences.includes(a))) throw new Error('JWT issued to an application this registry does not accept');
    if (claims.tokenType && claims.tokenType !== 'access-token') throw new Error(`a ${claims.tokenType} is not an access token`);
    if (!claims.sub) throw new Error('JWT without subject');
    return claims;
  }

  // The provider's key for `kid`, refetching its key set once when the key is
  // unknown (key rotation), at most once a minute.
  async signingKey(kid) {
    const pick = () => (kid ? this.jwks?.keys.get(kid) : this.jwks?.keys.size === 1 ? [...this.jwks.keys.values()][0] : undefined);
    if (!pick() && (!this.jwks || Date.now() - this.jwks.fetchedAt > 60_000)) {
      const cfg = await this.config();
      if (!cfg.jwks_uri) throw new Error('the identity provider publishes no jwks_uri');
      const res = await this.fetch(cfg.jwks_uri);
      if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
      const keys = new Map();
      for (const [i, jwk] of ((await res.json()).keys ?? []).entries()) {
        if (jwk.use && jwk.use !== 'sig') continue;
        try { keys.set(jwk.kid ?? `#${i}`, createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* a key type node cannot use */ }
      }
      this.jwks = { keys, fetchedAt: Date.now() };
    }
    const key = pick();
    if (!key) throw new Error(`unknown JWT signing key ${kid ?? '(no kid)'}`);
    return key;
  }
}

function decodeJwtPayload(jwt) {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
