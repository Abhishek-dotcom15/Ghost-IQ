import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDevice, resolveNetwork } from '@ghostiq/personas';
import { PlaywrightDriver } from './driver.js';

// Real-browser test of the guardrails and evidence capture. Skipped where Chromium is not
// installed (the CI "verify" job); the CI smoke job runs the full stack with a browser.
const hasBrowser = (() => {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const PAGE = `<!doctype html>
<title>Test shop</title>
<h1>Shop</h1>
<label for="q">Search</label><input id="q" />
<button id="broken" onclick="fetch('/api/broken')">Load stock</button>
<button id="crash" onclick="setTimeout(() => { throw new Error('boom') })">Crash</button>
<a href="https://example.org/offsite">Partner site</a>
<a href="/about">About</a>`;

let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/broken') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"db down"}');
      return;
    }
    if (req.url === '/about') {
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<title>About</title><h1>About us</h1>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe.skipIf(!hasBrowser)('PlaywrightDriver', () => {
  it('observes refs, records bugs as issues, and blocks off-site navigation', async () => {
    const driver = await PlaywrightDriver.launch({
      allowedOrigins: [origin],
      headless: true,
      trace: false,
    });
    try {
      await driver.open(`${origin}/`);
      await driver.collect();

      const observation = await driver.observe();
      const byName = (name: string) =>
        [...observation.elements.values()].find((e) => e.name === name)!;
      expect(observation.title).toBe('Test shop');
      expect(byName('Search')).toMatchObject({ role: 'textbox' });

      await driver.execute({
        type: 'fill',
        ref: byName('Search').ref,
        text: 'socks',
        reason: 'search',
      });
      await driver.execute({ type: 'click', ref: byName('Load stock').ref, reason: 'load' });
      await driver.execute({ type: 'click', ref: byName('Crash').ref, reason: 'crash' });
      await driver.execute({ type: 'wait', ms: 300, reason: 'let requests settle' });
      const afterBugs = await driver.collect();
      expect(afterBugs.issues.map((i) => i.kind)).toEqual(
        expect.arrayContaining(['http_error', 'console_error', 'page_error']),
      );
      expect(afterBugs.network).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: `${origin}/api/broken`, status: 500 }),
        ]),
      );
      expect(afterBugs.screenshotBase64?.length).toBeGreaterThan(100);

      await driver.execute({ type: 'click', ref: byName('Partner site').ref, reason: 'explore' });
      const afterOffsite = await driver.collect();
      expect(driver.url()).toBe(`${origin}/`);
      expect(afterOffsite.issues).toEqual([
        expect.objectContaining({ kind: 'blocked_navigation', url: 'https://example.org/offsite' }),
      ]);

      const fresh = await driver.observe();
      const about = [...fresh.elements.values()].find((e) => e.name === 'About')!;
      await driver.execute({ type: 'click', ref: about.ref, reason: 'explore' });
      expect(driver.url()).toBe(`${origin}/about`);
    } finally {
      await driver.close();
    }
  }, 60_000);

  it('applies persona device, network, typing speed, reload, history and offline', async () => {
    const driver = await PlaywrightDriver.launch({
      allowedOrigins: [origin],
      headless: true,
      trace: false,
      device: resolveDevice('iphone-13'),
      network: resolveNetwork('fast-3g'),
      typingDelayMs: 5,
    });
    try {
      await driver.open(`${origin}/`);
      const { screenshotBase64 } = await driver.collect();
      // PNG width lives in bytes 16-19 of the header: 390 CSS px x DPR 3.
      expect(Buffer.from(screenshotBase64!, 'base64').readUInt32BE(16)).toBe(1170);

      const search = [...(await driver.observe()).elements.values()].find(
        (e) => e.name === 'Search',
      )!;
      await driver.execute({
        type: 'fill',
        ref: search.ref,
        text: 'zoë 👻',
        reason: 'type slowly',
      });
      expect((await driver.observe()).snapshot).toContain('zoë 👻');

      await driver.execute({ type: 'reload', reason: 'refresh' });
      await driver.execute({ type: 'navigate', path: '/about', reason: 'go' });
      await driver.execute({ type: 'goBack', reason: 'back' });
      expect(driver.url()).toBe(`${origin}/`);
      await driver.execute({ type: 'goForward', reason: 'forward' });
      expect(driver.url()).toBe(`${origin}/about`);

      await driver.execute({ type: 'navigate', path: '/', reason: 'home' });
      await driver.collect();
      const button = [...(await driver.observe()).elements.values()].find(
        (e) => e.name === 'Load stock',
      )!;

      await driver.setOffline(true);
      await driver.execute({ type: 'click', ref: button.ref, reason: 'while offline' });
      await driver.execute({ type: 'wait', ms: 300, reason: 'settle' });
      const offline = await driver.collect();
      // The failed request, plus the app's own unhandled "Failed to fetch": both are evidence.
      expect(offline.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'request_failed',
            message: expect.stringContaining('INTERNET_DISCONNECTED'),
          }),
          expect.objectContaining({
            kind: 'page_error',
            message: expect.stringContaining('Failed to fetch'),
          }),
        ]),
      );

      await driver.setOffline(false);
      await driver.execute({ type: 'click', ref: button.ref, reason: 'back online' });
      await driver.execute({ type: 'wait', ms: 1500, reason: 'settle (3G latency)' });
      const online = await driver.collect();
      expect(online.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'http_error', status: 500 })]),
      );
      expect(online.issues.some((i) => i.kind === 'request_failed')).toBe(false);
    } finally {
      await driver.close();
    }
  }, 60_000);
});
