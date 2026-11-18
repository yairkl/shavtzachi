/**
 * The service-account token script, tested with a real RSA key pair and a local stand-in for Google's token endpoint
 * that verifies the signature exactly as Google would.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { signAssertion, getServiceAccountToken, DEFAULT_SCOPES } from '../../scripts/service-account-token.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

let server; let url; let lastClaims; let mode = 'ok';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const [h, c, sig] = (form.get('assertion') || '').split('.');
      const valid = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, sig, 'base64url');
      lastClaims = valid ? JSON.parse(Buffer.from(c, 'base64url').toString()) : null;
      if (mode === 'denied') { res.writeHead(403); res.end('{"error":"access_denied"}'); return; }
      if (!valid || form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') { res.writeHead(400); res.end('{"error":"invalid_grant"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'ya29.test-token', expires_in: 3600, token_type: 'Bearer' }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}/token`;
});
afterAll(() => new Promise((r) => server.close(r)));

const key = () => ({ type: 'service_account', client_email: 'ci@example.iam.gserviceaccount.com', private_key: privateKey, token_uri: url });

describe('service-account token', () => {
  it('signs a JWT that verifies with the matching public key and carries the right claims', () => {
    const jwt = signAssertion(key(), DEFAULT_SCOPES, 1_700_000_000);
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, sig, 'base64url')).toBe(true);
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      iss: 'ci@example.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
      aud: url,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });

  it('gets an access token from the token endpoint', async () => {
    mode = 'ok';
    expect(await getServiceAccountToken(key())).toBe('ya29.test-token');
    expect(lastClaims.iss).toBe('ci@example.iam.gserviceaccount.com'); // the endpoint accepted the signature
  });

  it('reports a refusal with Google\'s message and never echoes the private key', async () => {
    mode = 'denied';
    const err = await getServiceAccountToken(key()).catch((e) => e);
    expect(err.message).toMatch(/refused the token request \(403\).*access_denied/);
    expect(err.message).not.toContain('PRIVATE KEY');
    mode = 'ok';
  });

  it('rejects a key without the needed fields', () => {
    expect(() => signAssertion({ client_email: 'x' })).toThrow(/client_email and private_key/);
    expect(() => signAssertion(null)).toThrow(/client_email and private_key/);
  });

  // async on purpose: the fake token endpoint lives in this very process and must stay free to answer
  const run = (env) => new Promise((resolve) => {
    execFile(process.execPath, ['scripts/service-account-token.mjs'], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
  });

  it('the command line prints the token and explains problems without leaking the key', async () => {
    const ok = await run({ GOOGLE_SA_KEY: JSON.stringify(key()) });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('ya29.test-token'); // nothing else on stdout, so it can be captured directly
    const missing = await run({});
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/Set GOOGLE_SA_KEY/);
    const bad = await run({ GOOGLE_SA_KEY: 'not json {{ PRIVATE KEY' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/not valid JSON/);
    expect(bad.stderr).not.toContain('PRIVATE KEY');
  });
});
