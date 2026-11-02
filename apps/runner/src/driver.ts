import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { BrowserDriver, Observation, StepSignals } from '@ghostiq/core';
import type { NetworkConditions, ResolvedDevice } from '@ghostiq/personas';
import {
  isAllowedUrl,
  normalizeRoute,
  parseAriaSnapshot,
  type AgentAction,
  type NetworkRequestRecord,
  type StepIssue,
} from '@ghostiq/shared';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Request,
  type Response,
} from 'playwright';
import {
  DuplicateSubmissionDetector,
  checkCookies,
  checkSecurityHeaders,
  scanBody,
} from './oracles.js';

export interface DriverOptions {
  allowedOrigins: string[];
  headless: boolean;
  /** Playwright storageState file with a logged-in session (cookies + localStorage). */
  storageStatePath?: string;
  trace: boolean;
  actionTimeoutMs?: number;
  /** Persona device: viewport, touch, user agent. Defaults to a 1280x720 laptop. */
  device?: ResolvedDevice;
  /** Persona network throttling (Chromium only); null for no throttling. */
  network?: NetworkConditions | null;
  /** Per-keystroke delay when typing; 0 fills instantly. */
  typingDelayMs?: number;
}

const NAVIGATION_TIMEOUT_MS = 20_000;
const SCROLL_PX = 600;
/** A request with no response after this long is reported as hanging (spinner-forever). */
const HANG_MS = 8_000;
/** Bodies above this size are not scanned. */
const MAX_SCAN_BYTES = 200_000;
/** Core Web Vitals "poor" thresholds. */
const CLS_POOR = 0.1;
const LCP_POOR_MS = 4000;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** Text our naughty-string probes make an injected script show (see personas inputs). */
const PROBE_DIALOG = /^(ghostiq|1)$/;

/** Collects layout-shift and LCP in the page; read at the end of each step. */
const VITALS_SCRIPT = `(() => {
  const vitals = (window.__ghostiqVitals = { cls: 0, lcp: 0 });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) vitals.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) vitals.lcp = entries[entries.length - 1].startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
})();`;

interface AxeViolation {
  id: string;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  helpUrl: string;
  nodes: Array<{ html: string }>;
}

/** Playwright implementation of the agent's browser: observation, actions, guardrails, oracles. */
export class PlaywrightDriver implements BrowserDriver {
  private network: NetworkRequestRecord[] = [];
  private issues: StepIssue[] = [];
  private readonly started = new Map<Request, number>();
  private readonly hangReported = new WeakSet<Request>();
  /** Async oracle work (body scans, cookie reads) that must finish before a step is collected. */
  private readonly pending = new Set<Promise<void>>();
  /** Each defect is reported once per run; the server merges across runs. */
  private readonly reported = new Set<string>();
  private readonly auditedStates = new Set<string>();
  private readonly duplicates = new DuplicateSubmissionDetector();
  /** Where to return after a blocked navigation leaves Chromium on its error page. */
  private lastAllowedUrl: string | undefined;
  /** True while axe-core runs (it opens a helper page that the popup guard must ignore). */
  private auditing = false;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly options: DriverOptions,
    /** Present when the persona throttles the network; it owns Chromium's network state. */
    private readonly cdp?: CDPSession,
  ) {}

  static async launch(options: DriverOptions): Promise<PlaywrightDriver> {
    const browser = await chromium.launch({ headless: options.headless });
    const storageState =
      options.storageStatePath && fs.existsSync(options.storageStatePath)
        ? options.storageStatePath
        : undefined;
    if (options.storageStatePath && !storageState) {
      console.warn(
        `storageState file not found: ${options.storageStatePath} (continuing logged out)`,
      );
    }
    const device = options.device;
    const context = await browser.newContext({
      viewport: device?.viewport ?? { width: 1280, height: 720 },
      isMobile: device?.isMobile ?? false,
      hasTouch: device?.hasTouch ?? false,
      deviceScaleFactor: device?.deviceScaleFactor ?? 1,
      ...(device?.userAgent ? { userAgent: device.userAgent } : {}),
      storageState,
    });
    if (options.trace) await context.tracing.start({ screenshots: true, snapshots: true });
    await context.addInitScript(VITALS_SCRIPT);
    const page = await context.newPage();
    let cdp: CDPSession | undefined;
    if (options.network) {
      // Chromium DevTools protocol: the same throttling as DevTools' 3G presets.
      cdp = await context.newCDPSession(page);
      await cdp.send('Network.emulateNetworkConditions', { offline: false, ...options.network });
    }
    page.setDefaultTimeout(options.actionTimeoutMs ?? 5_000);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    const driver = new PlaywrightDriver(browser, context, page, options, cdp);
    await driver.installGuards();
    driver.installListeners();
    return driver;
  }

  /** Adds an issue unless the same defect was already reported in this run. */
  private report(key: string, issue: StepIssue) {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.issues.push(issue);
  }

  private track(work: Promise<void>) {
    const p = work.catch(() => {}).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Origin allowlist enforced in the browser itself: off-site main-frame navigations are aborted. */
  private async installGuards() {
    await this.context.route('**/*', async (route, request) => {
      let mainFrameNavigation = false;
      try {
        mainFrameNavigation =
          request.isNavigationRequest() && request.frame() === this.page.mainFrame();
      } catch {
        // service-worker requests have no frame
      }
      if (mainFrameNavigation && !isAllowedUrl(request.url(), this.options.allowedOrigins)) {
        this.issues.push({
          kind: 'blocked_navigation',
          message: `Blocked navigation to ${request.url()} (outside allowed origins).`,
          url: request.url(),
        });
        await route.abort('blockedbyclient');
        return;
      }
      await route.fallback();
    });

    // New tabs/windows are outside the agent's view: close them and note it.
    // (axe-core opens a helper page of its own while it runs; that one must stay.)
    this.context.on('page', (popup) => {
      if (popup === this.page || this.auditing) return;
      this.issues.push({
        kind: 'blocked_navigation',
        message: `Closed a popup window (${popup.url() || 'about:blank'}).`,
      });
      void popup.close().catch(() => {});
    });
  }

  private installListeners() {
    const tracked = (request: Request) => {
      const type = request.resourceType();
      return type === 'fetch' || type === 'xhr' || type === 'document';
    };

    this.page.on('request', (request) => {
      if (tracked(request)) this.started.set(request, Date.now());
    });

    this.page.on('response', (response) => {
      const request = response.request();
      const startedAt = this.started.get(request);
      if (startedAt === undefined) return;
      this.started.delete(request);
      const status = response.status();
      const url = request.url();
      const method = request.method();
      this.network.push({ url, method, status, latencyMs: Date.now() - startedAt });

      if (status >= 500) {
        this.issues.push({
          kind: 'http_error',
          message: `${method} ${url} returned ${status}.`,
          url,
          status,
          method,
        });
      }
      if (status >= 200 && status < 300) {
        const duplicate = this.duplicates.observe(method, url, request.postData(), Date.now());
        if (duplicate) this.report(`dup|${method}|${normalizeRoute(url)}`, duplicate);
      }
      if (isMainFrameDocument(request, this.page)) this.inspectDocument(response);
      this.track(this.inspectResponse(response));
    });

    this.page.on('requestfailed', (request) => {
      const startedAt = this.started.get(request);
      if (startedAt === undefined) return;
      this.started.delete(request);
      const reason = request.failure()?.errorText ?? 'failed';
      // Aborts we caused (allowlist) or that navigation caused are not app bugs.
      if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(reason)) return;
      this.network.push({
        url: request.url(),
        method: request.method(),
        status: 0,
        latencyMs: Date.now() - startedAt,
      });
      if (/TOO_MANY_REDIRECTS/.test(reason)) {
        this.report(`loop|${normalizeRoute(request.url())}`, {
          kind: 'redirect_loop',
          message: `${request.url()} redirects in a loop (${reason}).`,
          url: request.url(),
        });
        return;
      }
      this.issues.push({
        kind: 'request_failed',
        message: `${request.method()} ${request.url()} failed: ${reason}`,
        url: request.url(),
        method: request.method(),
      });
    });

    this.page.on('framenavigated', (frame) => {
      if (frame !== this.page.mainFrame()) return;
      if (isAllowedUrl(frame.url(), this.options.allowedOrigins)) this.lastAllowedUrl = frame.url();
      // Leaving a page cancels its in-flight fetches, but Chromium does not always report
      // that as a failure. Forget them, or they would look like hanging requests.
      for (const request of this.started.keys()) {
        if (request.resourceType() !== 'document') this.started.delete(request);
      }
    });

    this.page.on('console', (message) => {
      if (message.type() !== 'error') return;
      // Chromium's own "Failed to load resource" lines duplicate the network oracle.
      if (/^Failed to load resource/.test(message.text())) return;
      this.issues.push({
        kind: 'console_error',
        message: message.text().slice(0, 2000),
        url: this.page.url(),
      });
    });

    this.page.on('pageerror', (error) => {
      this.issues.push({
        kind: 'page_error',
        message: `Uncaught ${error.name}: ${error.message}`.slice(0, 2000),
        url: this.page.url(),
        detail: error.stack?.slice(0, 2000),
      });
    });

    // A dialog with our probe text means a string we typed was executed as script (XSS).
    this.page.on('dialog', (dialog) => {
      if (dialog.type() !== 'beforeunload' && PROBE_DIALOG.test(dialog.message())) {
        this.report(`xss|${normalizeRoute(this.page.url())}`, {
          kind: 'script_injection',
          message: `Text typed into the page was executed as script: a ${dialog.type()} showed "${dialog.message()}".`,
          url: this.page.url(),
          detail: dialog.message(),
        });
      }
      void dialog.dismiss().catch(() => {});
    });
  }

  /** Header and status checks for a top-level page load. */
  private inspectDocument(response: Response) {
    const url = response.url();
    const status = response.status();
    const route = normalizeRoute(url);
    if (status === 404 || status === 410) {
      this.report(`404|${route}`, {
        kind: 'broken_link',
        message: `Navigated to ${new URL(url).pathname}, which returned ${status}.`,
        url,
        status,
      });
    }
    const origin = new URL(url).origin;
    for (const issue of checkSecurityHeaders(response.headers(), url)) {
      this.report(`hdr|${origin}|${issue.rule}`, issue);
    }
  }

  /** Cookies and body scans; async because they read headers and bodies. */
  private async inspectResponse(response: Response) {
    const url = response.url();
    const cookies = await response.headerValues('set-cookie');
    for (const issue of checkCookies(cookies, url)) this.report(`cookie|${issue.rule}`, issue);

    const type = response.headers()['content-type'] ?? '';
    const scannable = /json|text|html/.test(type);
    const length = Number(response.headers()['content-length'] ?? 0);
    if (!scannable || length > MAX_SCAN_BYTES) return;
    const body = await response.text();
    for (const issue of scanBody(body, url, response.status())) {
      this.report(`body|${issue.rule}|${normalizeRoute(url)}`, issue);
    }
  }

  async open(url: string): Promise<void> {
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    if (
      response &&
      response.status() >= 400 &&
      response.status() !== 404 &&
      response.status() < 500
    ) {
      this.issues.push({
        kind: 'http_error',
        message: `Start page returned ${response.status()}.`,
        url,
        status: response.status(),
      });
    }
  }

  url(): string {
    return this.page.url();
  }

  async observe(): Promise<Observation> {
    // Chromium can commit its error page after the failed navigation already returned;
    // never let the agent look at (or act from) a page outside the allowed origins.
    await this.returnIfOffsite();
    const snapshot = await this.page.ariaSnapshot({ mode: 'ai', timeout: 10_000 });
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      snapshot,
      elements: parseAriaSnapshot(snapshot),
    };
  }

  async execute(action: Exclude<AgentAction, { type: 'finish' }>): Promise<void> {
    try {
      await this.perform(action);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    } finally {
      // Also after failures: a redirect loop or blocked navigation leaves chrome-error://.
      await this.returnIfOffsite();
    }
  }

  private async perform(action: Exclude<AgentAction, { type: 'finish' }>): Promise<void> {
    const page = this.page;
    switch (action.type) {
      case 'click':
        await page.getByRef(action.ref).click();
        break;
      case 'fill': {
        const field = page.getByRef(action.ref);
        const isNumber = (await field.getAttribute('type').catch(() => null)) === 'number';
        if (this.options.typingDelayMs || isNumber) {
          // Number inputs reject fill() with non-numeric text; type it like a user would
          // and let the browser decide what it accepts.
          await field.clear();
          await field.pressSequentially(action.text, { delay: this.options.typingDelayMs ?? 0 });
        } else {
          await field.fill(action.text);
        }
        break;
      }
      case 'select':
        await page.getByRef(action.ref).selectOption(action.option);
        break;
      case 'hover':
        await page.getByRef(action.ref).hover();
        break;
      case 'press':
        await page.keyboard.press(action.key);
        break;
      case 'scroll':
        await page.mouse.wheel(0, action.direction === 'down' ? SCROLL_PX : -SCROLL_PX);
        break;
      case 'goBack':
        await page.goBack({ waitUntil: 'domcontentloaded' });
        break;
      case 'goForward':
        await page.goForward({ waitUntil: 'domcontentloaded' });
        break;
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded' });
        break;
      case 'navigate':
        // The core already checked the allowlist; the route guard is the second line of defence.
        await page.goto(new URL(action.path, page.url()).toString(), {
          waitUntil: 'domcontentloaded',
        });
        break;
      case 'wait':
        await page.waitForTimeout(action.ms);
        break;
    }
  }

  /**
   * An aborted off-site navigation leaves Chromium on chrome-error://. Go back to the last
   * allowed page so the agent keeps exploring the app instead of an error screen.
   */
  private async returnIfOffsite() {
    // A failed navigation can commit Chromium's error page a moment later: check twice.
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = this.page.url();
      if (
        !isAllowedUrl(current, this.options.allowedOrigins) &&
        this.lastAllowedUrl &&
        current !== 'about:blank'
      ) {
        await this.page
          .goto(this.lastAllowedUrl, { waitUntil: 'domcontentloaded' })
          .catch(() => {});
      }
      if (attempt === 0) await this.page.waitForTimeout(150);
    }
  }

  async collect(): Promise<StepSignals> {
    // Evidence must describe the app, never Chromium's own error page.
    await this.page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => {});
    await this.returnIfOffsite();
    // Let body scans and cookie reads for this step finish (bounded, never blocks a run).
    await Promise.race([Promise.allSettled([...this.pending]), sleep(3000)]);
    this.checkHangingRequests();

    const [a11y, screenshot] = await Promise.all([
      this.checkPage().catch((err: unknown) => {
        // Never silently: a broken oracle looks exactly like a clean app.
        console.warn(`[oracle] page checks failed: ${(err as Error).message.split('\n')[0]}`);
        return undefined;
      }),
      this.page
        .screenshot({ type: 'png' })
        .then((b) => b.toString('base64'))
        .catch(() => undefined),
    ]);

    const network = this.network;
    const issues = this.issues;
    this.network = [];
    this.issues = [];
    return { network, issues, a11yViolations: a11y, screenshotBase64: screenshot };
  }

  private checkHangingRequests() {
    const now = Date.now();
    for (const [request, startedAt] of this.started) {
      if (now - startedAt < HANG_MS || this.hangReported.has(request)) continue;
      this.hangReported.add(request);
      this.report(`hang|${request.method()}|${normalizeRoute(request.url())}`, {
        kind: 'hanging_request',
        method: request.method(),
        message: `${request.method()} ${new URL(request.url()).pathname} has not responded after ${Math.round((now - startedAt) / 1000)} s; the UI may wait forever.`,
        url: request.url(),
      });
    }
  }

  /**
   * Page-level oracles: horizontal overflow, Core Web Vitals, and axe-core (WCAG 2.x)
   * whenever the page content changed. Returns the step's violations for the a11y tab.
   */
  private async checkPage(): Promise<string | undefined> {
    const url = this.page.url();
    if (!isAllowedUrl(url, this.options.allowedOrigins)) return undefined;
    const route = normalizeRoute(url);

    const state = await this.page.evaluate(() => {
      const doc = document.documentElement;
      const vitals = (window as unknown as { __ghostiqVitals?: { cls: number; lcp: number } })
        .__ghostiqVitals;
      // Mobile browsers widen the layout viewport to fit oversized content, so compare
      // against the device screen, not innerWidth.
      const width = Math.min(window.innerWidth, window.screen.width || window.innerWidth);
      // Without a responsive viewport tag, phones lay the page out at desktop width (~980px)
      // and zoom out: there is no overflow to report on such pages.
      const responsive = !!document.querySelector('meta[name="viewport"][content*="device-width"]');
      const mobileLayout = window.screen.width < window.innerWidth;
      return {
        html: document.contentType === 'text/html',
        overflow: mobileLayout && !responsive ? 0 : doc.scrollWidth - width,
        width,
        cls: vitals?.cls ?? 0,
        lcp: vitals?.lcp ?? 0,
        shape: `${document.querySelectorAll('*').length}:${document.body?.innerText.length ?? 0}`,
      };
    });
    // JSON, images and other non-HTML documents are shown by Chromium's own viewers.
    if (!state.html) return undefined;

    if (state.overflow > 2) {
      this.report(`overflow|${route}|${state.width}`, {
        kind: 'layout_overflow',
        message: `Content is ${state.overflow}px wider than the ${state.width}px viewport: the page scrolls sideways.`,
        url,
        detail: `scrollWidth exceeds viewport by ${state.overflow}px at width ${state.width}`,
      });
    }
    if (state.cls > CLS_POOR) {
      this.report(`cls|${route}`, {
        kind: 'web_vital',
        rule: 'cls',
        message: `Cumulative Layout Shift is ${state.cls.toFixed(2)} (poor is above ${CLS_POOR}): content jumps while loading.`,
        url,
        detail: state.cls.toFixed(3),
      });
    }
    // Under simulated 3G, slow paint is caused by the persona, not the app.
    if (state.lcp > LCP_POOR_MS && !this.options.network) {
      this.report(`lcp|${route}`, {
        kind: 'web_vital',
        rule: 'lcp',
        message: `Largest Contentful Paint took ${(state.lcp / 1000).toFixed(1)} s (poor is above ${LCP_POOR_MS / 1000} s).`,
        url,
        detail: String(Math.round(state.lcp)),
      });
    }

    const stateKey = `${route}|${state.shape}`;
    if (this.auditedStates.has(stateKey)) return undefined;
    this.auditedStates.add(stateKey);

    this.auditing = true;
    let violations: AxeViolation[];
    try {
      const results = await new AxeBuilder({ page: this.page }).withTags(AXE_TAGS).analyze();
      violations = results.violations as AxeViolation[];
    } finally {
      this.auditing = false;
    }
    // The page navigated while axe ran: the results describe neither page reliably.
    if (this.page.url() !== url) return undefined;
    for (const v of violations) {
      this.report(`a11y|${v.id}|${route}`, {
        kind: 'a11y',
        rule: v.id,
        impact: v.impact ?? 'moderate',
        message: `${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'})`,
        url,
        detail: `${v.nodes[0]?.html.slice(0, 300) ?? ''}\n${v.helpUrl}`,
      });
    }
    if (violations.length === 0) return undefined;
    return JSON.stringify(
      violations.map((v) => ({
        rule: v.id,
        impact: v.impact ?? 'moderate',
        description: `${v.help} (${v.nodes.length})`,
        element: v.nodes[0]?.html.slice(0, 200) ?? '',
      })),
    );
  }

  async setOffline(offline: boolean): Promise<void> {
    await this.context.setOffline(offline);
    // Throttling and offline share one DevTools setting; re-send it so neither overrides the other.
    if (this.cdp && this.options.network) {
      await this.cdp.send('Network.emulateNetworkConditions', { offline, ...this.options.network });
    }
  }

  /** Writes the Playwright trace to `path` (no-op when tracing is off). */
  async saveTrace(path: string): Promise<boolean> {
    if (!this.options.trace) return false;
    await this.context.tracing.stop({ path });
    return true;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

function isMainFrameDocument(request: Request, page: Page): boolean {
  try {
    return request.resourceType() === 'document' && request.frame() === page.mainFrame();
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
