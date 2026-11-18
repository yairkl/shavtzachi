import { describe, it, expect } from 'vitest';
import { isAccessError } from '../lib/errors';
import { makeService } from './helpers/fakeSheets';

const err = (status, message = '') => ({ response: { status, data: { error: { message } } } });

describe('which Google errors mean "no access to this spreadsheet"', () => {
  it('permission and not-found do; rate limits, expired sessions, server and network trouble do not', () => {
    expect(isAccessError(err(403, 'The caller does not have permission'))).toBe(true);
    expect(isAccessError(err(404, 'Requested entity was not found.'))).toBe(true);
    expect(isAccessError(err(403, 'Quota exceeded for quota metric'))).toBe(false);
    expect(isAccessError(err(403, 'Rate Limit Exceeded'))).toBe(false);
    expect(isAccessError(err(401))).toBe(false);
    expect(isAccessError(err(429))).toBe(false);
    expect(isAccessError(err(500))).toBe(false);
    expect(isAccessError(new Error('Network Error'))).toBe(false);
    expect(isAccessError(null)).toBe(false);
  });

  it('checkAccess reports ok, a refusal with a readable message, and does not lock on transient errors', async () => {
    const { service, fake } = await makeService({});
    expect(await service.checkAccess()).toEqual({ ok: true });
    fake.deny = { status: 403, message: 'The caller does not have permission' };
    const denied = await service.checkAccess();
    expect(denied.ok).toBe(false);
    expect(denied.message).toMatch(/permission to edit this spreadsheet/);
    fake.deny = { status: 404, message: 'Requested entity was not found.' };
    expect((await service.checkAccess()).message).toMatch(/not found/i);
    fake.deny = { status: 500, message: 'backend error' };
    expect(await service.checkAccess()).toEqual({ ok: true });
    fake.deny = { status: 403, message: 'Quota exceeded' };
    expect(await service.checkAccess()).toEqual({ ok: true });
  });
});
