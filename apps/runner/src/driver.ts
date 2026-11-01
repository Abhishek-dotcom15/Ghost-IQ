import fs from 'node:fs';
import type { BrowserDriver, Observation, StepSignals } from '@ghostiq/core';
import type { NetworkConditions, ResolvedDevice } from '@ghostiq/personas';
import {
  isAllowedUrl,
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
} from 'playwright';

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

/** Playwright implementation of the agent's browser: observation, actions, guardrails, evidence. */
export class PlaywrightDriver implements BrowserDriver {
  private network: NetworkRequestRecord[] = [];
  private issues: StepIssue[] = [];
  private readonly started = new Map<Request, number>();
  /** Where to return after a blocked navigation leaves Chromium on its error page. */
  private lastAllowedUrl: string | undefined;

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
    this.context.on('page', (popup) => {
      if (popup === this.page) return;
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
      this.network.push({
        url: request.url(),
        method: request.method(),
        status,
        latencyMs: Date.now() - startedAt,
      });
      if (status >= 500) {
        this.issues.push({
          kind: 'http_error',
          message: `${request.method()} ${request.url()} returned ${status}.`,
          url: request.url(),
          status,
        });
      }
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
      this.issues.push({
        kind: 'request_failed',
        message: `${request.method()} ${request.url()} failed: ${reason}`,
        url: request.url(),
      });
    });

    this.page.on('framenavigated', (frame) => {
      if (
        frame === this.page.mainFrame() &&
        isAllowedUrl(frame.url(), this.options.allowedOrigins)
      ) {
        this.lastAllowedUrl = frame.url();
      }
    });

    this.page.on('console', (message) => {
      if (message.type() !== 'error') return;
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
      });
    });
  }

  async open(url: string): Promise<void> {
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    if (!response) return;
    if (response.status() >= 400 && response.status() < 500) {
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
    const snapshot = await this.page.ariaSnapshot({ mode: 'ai', timeout: 10_000 });
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      snapshot,
      elements: parseAriaSnapshot(snapshot),
    };
  }

  async execute(action: Exclude<AgentAction, { type: 'finish' }>): Promise<void> {
    const page = this.page;
    switch (action.type) {
      case 'click':
        await page.getByRef(action.ref).click();
        break;
      case 'fill': {
        const field = page.getByRef(action.ref);
        if (this.options.typingDelayMs) {
          await field.clear();
          await field.pressSequentially(action.text, { delay: this.options.typingDelayMs });
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
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await this.returnIfOffsite();
  }

  /**
   * An aborted off-site navigation leaves Chromium on chrome-error://. Go back to the last
   * allowed page so the agent keeps exploring the app instead of an error screen.
   */
  private async returnIfOffsite() {
    const current = this.page.url();
    if (isAllowedUrl(current, this.options.allowedOrigins) || !this.lastAllowedUrl) return;
    if (current === 'about:blank') return;
    await this.page.goto(this.lastAllowedUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  async collect(): Promise<StepSignals> {
    const network = this.network;
    const issues = this.issues;
    this.network = [];
    this.issues = [];

    const [a11y, screenshot] = await Promise.all([
      this.auditAccessibility().catch(() => undefined),
      this.page
        .screenshot({ type: 'png' })
        .then((b) => b.toString('base64'))
        .catch(() => undefined),
    ]);
    return { network, issues, a11yViolations: a11y, screenshotBase64: screenshot };
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

  /** Three basic checks kept from the prototype; Phase 4 replaces them with axe-core (WCAG). */
  private async auditAccessibility(): Promise<string | undefined> {
    const violations = await this.page.evaluate(() => {
      const list: Array<{ rule: string; impact: string; description: string; element: string }> =
        [];
      document.querySelectorAll('img').forEach((img, i) => {
        if (!img.getAttribute('alt')?.trim()) {
          list.push({
            rule: 'Image Alt Text Missing',
            impact: 'moderate',
            description: `Image ${i} has no alternative text.`,
            element: img.outerHTML.slice(0, 100),
          });
        }
      });
      document.querySelectorAll('input, select, textarea').forEach((node) => {
        const el = node as HTMLInputElement;
        if (['submit', 'button', 'hidden'].includes(el.type)) return;
        const labelled =
          (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
          el.closest('label') ||
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          el.getAttribute('placeholder');
        if (!labelled) {
          list.push({
            rule: 'Form Label Association Missing',
            impact: 'serious',
            description: `Field (type="${el.type || 'text'}") has no label.`,
            element: el.outerHTML.slice(0, 100),
          });
        }
      });
      document.querySelectorAll('button, [role="button"]').forEach((btn) => {
        if (!btn.textContent?.trim() && !btn.getAttribute('aria-label')) {
          list.push({
            rule: 'Button Name Descriptor Missing',
            impact: 'critical',
            description: 'Button has no text or aria-label.',
            element: btn.outerHTML.slice(0, 100),
          });
        }
      });
      return list;
    });
    return violations.length ? JSON.stringify(violations) : undefined;
  }
}
