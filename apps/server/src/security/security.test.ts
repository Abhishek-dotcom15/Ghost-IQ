import { describe, expect, it } from 'vitest';
import { RateLimiter, bucketFor } from './rate-limit.js';
import { BlockedTargetError, assertPublicUrl, isPrivateAddress } from './ssrf.js';

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['2606:4700::1111', false],
    ['not-an-ip', true],
  ])('%s -> %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe('assertPublicUrl', () => {
  const resolve = async (host: string) =>
    ({
      'public.test': ['93.184.216.34'],
      'rebind.test': ['93.184.216.34', '10.0.0.5'],
      'mock-app': ['172.18.0.3'],
    })[host] ?? [];

  it('allows public hosts and refuses private, non-http and credentialed URLs', async () => {
    await expect(
      assertPublicUrl('https://public.test/path', { allowedHosts: [], resolve }),
    ).resolves.toBeUndefined();
    for (const url of [
      'http://rebind.test',
      'http://10.0.0.1',
      'file:///etc/passwd',
      'http://u:p@public.test',
      'http://unknown.test',
      'nonsense',
    ]) {
      await expect(assertPublicUrl(url, { allowedHosts: [], resolve }), url).rejects.toBeInstanceOf(
        BlockedTargetError,
      );
    }
  });

  it('allows operator-listed internal hosts', async () => {
    await expect(
      assertPublicUrl('http://mock-app:3000', { allowedHosts: ['MOCK-APP'], resolve }),
    ).resolves.toBeUndefined();
  });
});

describe('RateLimiter', () => {
  it('allows the limit per window, then reports when to retry', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const bucket = { limit: 3, windowMs: 1000 };
    expect([1, 2, 3].map(() => limiter.take('k', bucket).allowed)).toEqual([true, true, true]);
    expect(limiter.take('k', bucket)).toMatchObject({ allowed: false, retryAfterS: 1 });
    expect(limiter.take('other', bucket).allowed).toBe(true);
    now = 1001;
    expect(limiter.take('k', bucket).allowed).toBe(true);
  });

  it('buckets routes', () => {
    expect(bucketFor('/auth/token')).toBe('auth');
    expect(bucketFor('/api/ai/next-action')).toBe('ai');
    expect(bucketFor('/api/projects')).toBe('api');
    expect(bucketFor('/assets/x.js')).toBeNull();
  });
});
