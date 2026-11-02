import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  issueToFinding,
  normalizeMessage,
  slowEndpointFindings,
  validationFindings,
  type StepForValidation,
} from './classify.js';

const PAGE = 'http://shop.test/products?x=1';

describe('issueToFinding', () => {
  it('maps server errors to the request route, keyed by status', () => {
    const f = issueToFinding(
      {
        kind: 'http_error',
        message: 'GET /api/products/3 returned 500',
        url: 'http://shop.test/api/products/3',
        status: 500,
        method: 'GET',
      },
      PAGE,
    );
    expect(f).toMatchObject({
      type: 'network_error',
      severity: 'high',
      route: '/api/products/:id',
      rule: '500',
    });
  });

  it('maps axe impact to severity and keys on the rule and page', () => {
    const f = issueToFinding(
      {
        kind: 'a11y',
        rule: 'color-contrast',
        impact: 'serious',
        message: 'Low contrast (3)',
        url: PAGE,
      },
      PAGE,
    );
    expect(f).toMatchObject({
      type: 'accessibility',
      severity: 'high',
      route: '/products',
      rule: 'color-contrast',
    });
  });

  it('treats headers, cookies and X-Powered-By as site-wide', () => {
    expect(
      issueToFinding(
        { kind: 'security_header', rule: 'x-content-type-options', message: 'm', url: PAGE },
        PAGE,
      ),
    ).toMatchObject({ route: '*' });
    expect(
      issueToFinding(
        { kind: 'info_exposure', rule: 'x-powered-by', message: 'm', url: PAGE },
        PAGE,
      ),
    ).toMatchObject({ route: '*', severity: 'low' });
    expect(
      issueToFinding(
        { kind: 'info_exposure', rule: 'secret', message: 'm', url: 'http://shop.test/api/debug' },
        PAGE,
      ),
    ).toMatchObject({ route: '/api/debug', severity: 'high' });
  });

  it('ranks script injection as critical and ignores agent notes', () => {
    expect(
      issueToFinding({ kind: 'script_injection', message: 'alert', url: PAGE }, PAGE)!.severity,
    ).toBe('critical');
    expect(issueToFinding({ kind: 'destructive_blocked', message: 'x' }, PAGE)).toBeNull();
    expect(issueToFinding({ kind: 'blocked_navigation', message: 'x' }, PAGE)).toBeNull();
  });
});

describe('fingerprint', () => {
  it('merges the same error with different numbers and URLs', () => {
    const a = issueToFinding(
      { kind: 'page_error', message: "Uncaught TypeError: Cannot read 'x' at line 42", url: PAGE },
      PAGE,
    )!;
    const b = issueToFinding(
      {
        kind: 'page_error',
        message: "Uncaught TypeError: Cannot read 'y' at line 97",
        url: 'http://shop.test/products?y=2',
      },
      PAGE,
    )!;
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(normalizeMessage('Failed at https://a.test/x/1 after 300 ms')).toBe(
      'failed at <url> after # ms',
    );
  });

  it('keeps different routes and rules apart', () => {
    const a = issueToFinding(
      { kind: 'a11y', rule: 'label', message: 'm', url: 'http://shop.test/' },
      'http://shop.test/',
    )!;
    const b = issueToFinding(
      { kind: 'a11y', rule: 'label', message: 'm', url: 'http://shop.test/cart' },
      'http://shop.test/cart',
    )!;
    const c = issueToFinding(
      { kind: 'a11y', rule: 'image-alt', message: 'm', url: 'http://shop.test/' },
      'http://shop.test/',
    )!;
    expect(new Set([fingerprint(a), fingerprint(b), fingerprint(c)]).size).toBe(3);
  });
});

describe('slowEndpointFindings', () => {
  it('flags routes whose average latency exceeds the threshold', () => {
    const findings = slowEndpointFindings([
      { method: 'GET', url: 'http://s.test/api/products?q=a', status: 200, latencyMs: 1600 },
      { method: 'GET', url: 'http://s.test/api/products?q=b', status: 200, latencyMs: 1700 },
      { method: 'GET', url: 'http://s.test/api/cart', status: 200, latencyMs: 40 },
      { method: 'GET', url: 'http://s.test/api/hang', status: 0, latencyMs: 30000 },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: 'slow_endpoint',
      route: '/api/products',
      severity: 'medium',
    });
    expect(findings[0]!.message).toContain('2 call(s)');
  });
});

describe('validationFindings', () => {
  const step = (n: number, partial: Partial<StepForValidation>): StepForValidation => ({
    stepNumber: n,
    action: 'CLICK',
    value: null,
    input: null,
    network: [],
    ...partial,
  });

  it('reports a successful submit after invalid generated values', () => {
    const findings = validationFindings([
      step(2, {
        action: 'FILL',
        value: '',
        input: { strategy: 'empty', kind: 'email', field: 'Email' },
      }),
      step(3, {
        action: 'FILL',
        value: 'Ava',
        input: { strategy: 'valid', kind: 'name', field: 'Full name' },
      }),
      step(4, {
        network: [{ method: 'POST', url: 'http://s.test/api/signup', status: 201, latencyMs: 5 }],
      }),
    ]);
    expect(findings).toEqual([
      expect.objectContaining({
        type: 'validation',
        route: '/api/signup',
        confidence: 'suspected',
        stepNumber: 4,
      }),
    ]);
    expect(findings[0]!.message).toContain('"Email" = "" [empty]');
  });

  it('stays quiet when the server rejects the input or only valid values were used', () => {
    expect(
      validationFindings([
        step(2, {
          action: 'FILL',
          value: 'a@b',
          input: { strategy: 'boundary', kind: 'email', field: 'Email' },
        }),
        step(3, {
          network: [{ method: 'POST', url: 'http://s.test/api/signup', status: 400, latencyMs: 5 }],
        }),
        step(4, {
          network: [{ method: 'POST', url: 'http://s.test/api/signup', status: 201, latencyMs: 5 }],
        }),
      ]),
    ).toEqual([]);
    expect(
      validationFindings([
        step(2, {
          action: 'FILL',
          value: 'ava@example.test',
          input: { strategy: 'valid', kind: 'email', field: 'Email' },
        }),
        step(3, {
          network: [{ method: 'POST', url: 'http://s.test/api/signup', status: 201, latencyMs: 5 }],
        }),
      ]),
    ).toEqual([]);
  });
});
