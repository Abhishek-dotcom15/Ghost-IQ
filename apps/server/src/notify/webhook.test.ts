import { describe, expect, it, vi } from 'vitest';
import { buildPayload, isSlackUrl, sendWebhook, shouldNotify, slackMessage } from './webhook.js';

const payload = buildPayload({
  project: { id: 'p1', name: 'Shop' },
  session: {
    id: 's1',
    name: 'Happy Path: Log in',
    persona: 'Happy Path User',
    mode: 'explore',
    status: 'FAILED',
    endReason: 'goal_not_met',
    summary: 'Could not log in',
    targetUrl: 'http://shop.test',
  },
  findings: [
    { severity: 'low', title: 'Missing header', route: '*' },
    { severity: 'high', title: 'POST /api/login returns 500', route: '/api/login' },
    { severity: 'medium', title: 'a11y <label>', route: '/' },
  ],
  publicUrl: 'https://ghostiq.example.com/',
});

describe('webhook payload', () => {
  it('counts findings by severity and lists the worst first', () => {
    expect(payload.findings.total).toBe(3);
    expect(payload.findings.bySeverity).toMatchObject({ high: 1, medium: 1, low: 1, critical: 0 });
    expect(payload.findings.top[0]!.severity).toBe('high');
    expect(payload.run.url).toBe('https://ghostiq.example.com/?session=s1');
  });

  it('applies the severity threshold', () => {
    expect(shouldNotify(payload)).toBe(true);
    expect(shouldNotify(payload, 'high')).toBe(true);
    expect(shouldNotify(payload, 'critical')).toBe(false);
  });

  it('formats Slack messages and escapes control characters', () => {
    const text = slackMessage(payload).text;
    expect(text).toContain(':x: *GhostIQ* run *Happy Path: Log in* on Shop: FAILED (goal_not_met)');
    expect(text).toContain('a11y &lt;label&gt;');
    expect(text).toContain('<https://ghostiq.example.com/?session=s1|Open in GhostIQ>');
    expect(isSlackUrl('https://hooks.slack.com/services/T/B/x')).toBe(true);
    expect(isSlackUrl('https://example.com/hook')).toBe(false);
  });

  it('sends Slack format to Slack and JSON elsewhere, and never throws', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('ok', { status: 200 }),
    );
    await sendWebhook(payload, { url: 'https://hooks.slack.com/services/x', fetch: fetchMock });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toHaveProperty('text');

    await sendWebhook(payload, { url: 'https://example.com/hook', fetch: fetchMock });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toMatchObject({
      event: 'run.completed',
    });

    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      sendWebhook(payload, { url: 'https://example.com/hook', fetch: failing }),
    ).resolves.toMatchObject({ sent: false, error: 'ECONNREFUSED' });

    expect(
      await sendWebhook(payload, {
        url: 'https://example.com/hook',
        minSeverity: 'critical',
        fetch: fetchMock,
      }),
    ).toEqual({ sent: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
