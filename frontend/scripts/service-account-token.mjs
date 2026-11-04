#!/usr/bin/env node
/**
 * Exchange a Google service-account key for a short-lived (one hour) access token, with nothing but Node.
 *
 *   GOOGLE_SA_KEY='{"type":"service_account",...}' node scripts/service-account-token.mjs
 *
 * prints the token. It signs a JWT with the key and trades it at Google's token endpoint (the standard "JWT bearer"
 * grant), so it needs no extra Google APIs enabled and no extra permissions on the service account - only the APIs
 * you actually call (Sheets, Drive). Used by .github/workflows/live.yml.
 */
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** Build the signed JWT that proves we hold the key. Exported for tests. */
export function signAssertion(key, scopes = DEFAULT_SCOPES, now = Math.floor(Date.now() / 1000)) {
  if (!key || !key.client_email || !key.private_key) throw new Error('The service account key must contain client_email and private_key.');
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({
    iss: key.client_email,
    scope: scopes.join(' '),
    aud: key.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key, 'base64url');
  return `${header}.${claims}.${signature}`;
}

/** Returns an access token for the service account. `fetchImpl` is injectable for tests. */
export async function getServiceAccountToken(key, scopes = DEFAULT_SCOPES, fetchImpl = fetch) {
  const assertion = signAssertion(key, scopes);
  const url = key.token_uri || 'https://oauth2.googleapis.com/token';
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Google refused the token request (${res.status}): ${body}`); // Google's error text only; never the key
  const token = JSON.parse(body).access_token;
  if (!token) throw new Error('Google answered without an access token.');
  return token;
}

// command line
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const raw = process.env.GOOGLE_SA_KEY;
    if (!raw) throw new Error('Set GOOGLE_SA_KEY to the contents of the service account JSON key.');
    let key;
    try { key = JSON.parse(raw); } catch { throw new Error('GOOGLE_SA_KEY is not valid JSON. Paste the whole JSON file as the secret.'); }
    process.stdout.write(await getServiceAccountToken(key, process.env.GOOGLE_SA_SCOPES ? process.env.GOOGLE_SA_SCOPES.split(/[ ,]+/) : DEFAULT_SCOPES));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
