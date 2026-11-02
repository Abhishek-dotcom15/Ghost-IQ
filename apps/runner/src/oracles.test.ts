import { describe, expect, it } from 'vitest';
import {
  DuplicateSubmissionDetector,
  checkCookies,
  checkSecurityHeaders,
  scanBody,
} from './oracles.js';

describe('checkSecurityHeaders', () => {
  it('flags missing hygiene headers and X-Powered-By', () => {
    const issues = checkSecurityHeaders({ 'x-powered-by': 'Express' }, 'http://app.test/');
    expect(issues.map((i) => i.rule)).toEqual([
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'x-powered-by',
    ]);
    expect(issues.at(-1)!.kind).toBe('info_exposure');
  });

  it('passes a well-configured HTTPS response', () => {
    expect(
      checkSecurityHeaders(
        {
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'strict-transport-security': 'max-age=63072000',
        },
        'https://app.test/',
      ),
    ).toEqual([]);
  });

  it('requires HSTS only on HTTPS', () => {
    const https = checkSecurityHeaders({}, 'https://app.test/').map((i) => i.rule);
    expect(https).toContain('strict-transport-security');
    expect(checkSecurityHeaders({}, 'http://app.test/').map((i) => i.rule)).not.toContain(
      'strict-transport-security',
    );
  });
});

describe('checkCookies', () => {
  it('flags session cookies without HttpOnly or SameSite, masking the value', () => {
    const [issue] = checkCookies(['session=demo-session-token; Path=/'], 'http://app.test/');
    expect(issue).toMatchObject({ kind: 'insecure_cookie', rule: 'session' });
    expect(issue!.message).toContain('HttpOnly, SameSite');
    expect(issue!.detail).not.toContain('session-token');
  });

  it('accepts a properly flagged cookie and only demands HttpOnly for sensitive names', () => {
    expect(checkCookies(['sid=x; HttpOnly; SameSite=Lax; Secure'], 'https://app.test/')).toEqual(
      [],
    );
    expect(checkCookies(['theme=dark; SameSite=Lax'], 'http://app.test/')).toEqual([]);
  });
});

describe('scanBody', () => {
  it('finds Node stack traces', () => {
    const body = JSON.stringify({
      error: 'boom',
      stack: 'TypeError: x\n    at getStock (/srv/shop/src/inventory.js:42:17)',
    });
    const [issue] = scanBody(body, 'http://app.test/api/products/3', 500);
    expect(issue).toMatchObject({ kind: 'info_exposure', rule: 'stack-trace', status: 500 });
    expect(issue!.detail).toContain('inventory.js:42:17');
  });

  it('finds secrets without storing them', () => {
    const issues = scanBody(
      '{"config":{"db_password":"hunter2-prod","stripe_api_key":"sk_live_51Hdemo0000000000"}}',
      'http://app.test/api/debug',
      200,
    );
    expect(issues).toEqual([expect.objectContaining({ rule: 'secret' })]);
    expect(JSON.stringify(issues)).not.toContain('hunter2');
  });

  it('ignores ordinary JSON', () => {
    expect(
      scanBody('{"items":[{"id":1,"name":"Mug"}],"password_hint":""}', 'http://a.test/x', 200),
    ).toEqual([]);
  });
});

describe('DuplicateSubmissionDetector', () => {
  it('reports the same successful POST twice within the window', () => {
    const d = new DuplicateSubmissionDetector(1500);
    expect(d.observe('POST', 'http://a.test/api/orders', '{"q":1}', 1000)).toBeNull();
    expect(d.observe('POST', 'http://a.test/api/orders', '{"q":1}', 1400)).toMatchObject({
      kind: 'duplicate_submission',
      method: 'POST',
    });
  });

  it('ignores GETs, different bodies and slow repeats', () => {
    const d = new DuplicateSubmissionDetector(1500);
    expect(d.observe('GET', 'http://a.test/x', null, 0)).toBeNull();
    expect(d.observe('GET', 'http://a.test/x', null, 10)).toBeNull();
    d.observe('POST', 'http://a.test/api/cart', '{"id":1}', 0);
    expect(d.observe('POST', 'http://a.test/api/cart', '{"id":2}', 100)).toBeNull();
    expect(d.observe('POST', 'http://a.test/api/cart', '{"id":1}', 5000)).toBeNull();
  });
});
