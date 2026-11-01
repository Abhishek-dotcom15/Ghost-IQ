import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Socket } from 'socket.io-client';

export class PlaywrightRunner {
  private browser: Browser | null = null;
  private socket: Socket;
  private serverUrl: string;

  constructor(socket: Socket, serverUrl: string) {
    this.socket = socket;
    this.serverUrl = serverUrl;
  }

  /**
   * Runs the autonomous test execution loop.
   */
  async runSession(data: { sessionId: string; targetUrl: string; persona: string; goal: string }) {
    const { sessionId, targetUrl, persona, goal } = data;
    console.log(`\n🚀 Starting test session for Goal: "${goal}" [Persona: ${persona}]`);

    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    const networkRequests: Array<{ url: string; method: string; status: number; latencyMs: number }> = [];
    const requestTimes = new Map<string, number>();

    // Listen to network traffic for API diagnostics
    page.on('request', (request) => {
      const url = request.url();
      // Only trace fetch/xhr calls to avoid bloating database with static assets (images, css)
      const resourceType = request.resourceType();
      if (resourceType === 'fetch' || resourceType === 'xhr' || url.includes('/api/')) {
        requestTimes.set(url, Date.now());
      }
    });

    page.on('response', (response) => {
      const url = response.url();
      if (requestTimes.has(url)) {
        const startTime = requestTimes.get(url)!;
        const latencyMs = Date.now() - startTime;
        networkRequests.push({
          url,
          method: response.request().method(),
          status: response.status(),
          latencyMs
        });
        requestTimes.delete(url);
      }
    });

    // Listen to console log warnings & errors
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleLogs.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
      }
    });

    page.on('pageerror', (err) => {
      consoleLogs.push(`[CRASH] Uncaught Exception: ${err.message}`);
    });

    const history: Array<{ stepNumber: number; action: string; description: string; status: 'PASSED' | 'FAILED'; error?: string }> = [];
    let stepNumber = 1;
    const maxSteps = 10;
    let currentUrl = targetUrl;
    let running = true;

    try {
      // Step 1: Initial navigation to Target URL
      console.log(`🔗 Navigating to target site: ${targetUrl}`);
      this.socket.emit('step-started', {
        sessionId,
        stepNumber,
        action: 'GOTO',
        description: `Navigating to ${targetUrl}`
      });

      const startTime = Date.now();
      const response = await page.goto(targetUrl, { waitUntil: 'load', timeout: 20000 });
      const latencyMs = Date.now() - startTime;

      if (response) {
        networkRequests.push({
          url: targetUrl,
          method: 'GET',
          status: response.status(),
          latencyMs
        });
      }

      currentUrl = page.url();
      const screenshot = (await page.screenshot({ type: 'png' })).toString('base64');

      this.socket.emit('step-completed', {
        sessionId,
        stepNumber,
        action: 'GOTO',
        description: `Successfully navigated to ${targetUrl}`,
        status: 'PASSED',
        screenshotBase64: screenshot,
        networkRequests: [...networkRequests]
      });

      history.push({
        stepNumber,
        action: 'GOTO',
        description: `Navigated to ${targetUrl}`,
        status: 'PASSED'
      });

      // Clear step network requests for the next phase
      networkRequests.length = 0;
      stepNumber++;

      // Step 2-10: Autonomous Action Planning Loop
      while (running && stepNumber <= maxSteps) {
        console.log(`\n🧠 Step ${stepNumber}: Requesting next action from AI Engine...`);

        // Generate simplified visual representation of page interactive nodes
        const htmlSnapshot = await page.evaluate(() => {
          const interactiveTags = ['a', 'button', 'input', 'select', 'textarea'];
          const elements = Array.from(document.querySelectorAll('*')) as HTMLElement[];
          
          const interactiveNodes = elements.filter((el: any) => {
            const tagName = el.tagName.toLowerCase();
            const isInteractiveTag = interactiveTags.includes(tagName);
            const style = window.getComputedStyle(el);
            const hasCursorPointer = style.cursor === 'pointer';
            const hasOnClick = el.hasAttribute('onclick') || (el as any).onclick;
            const isBtnRole = el.getAttribute('role') === 'button';
            const isVisible = el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            
            return isVisible && (isInteractiveTag || hasCursorPointer || hasOnClick || isBtnRole);
          });

          // Serialize into basic XML nodes
          return interactiveNodes.map((el: any, idx) => {
            const tagName = el.tagName.toLowerCase();
            const id = el.id ? ` id="${el.id}"` : '';
            const rawClass = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
            const className = rawClass ? ` class="${rawClass.split(' ').slice(0, 2).join(' ')}"` : '';
            const placeholder = el.getAttribute('placeholder') ? ` placeholder="${el.getAttribute('placeholder')}"` : '';
            const type = el.getAttribute('type') ? ` type="${el.getAttribute('type')}"` : '';
            const text = el.textContent?.trim().slice(0, 40).replace(/[\n\r]/g, '') || '';
            const name = el.getAttribute('name') ? ` name="${el.getAttribute('name')}"` : '';
            
            // Build visual representation
            if (tagName === 'input') {
              return `<input${id}${className}${type}${name}${placeholder} />`;
            } else if (tagName === 'button' || el.getAttribute('role') === 'button') {
              return `<button${id}${className}>${text}</button>`;
            } else if (tagName === 'a') {
              const href = el.getAttribute('href') ? ` href="${el.getAttribute('href')}"` : '';
              return `<a${id}${className}${href}>${text}</a>`;
            } else {
              return `<element tag="${tagName}"${id}${className}>${text}</element>`;
            }
          }).join('\n');
        });

        // Request next action plan from backend central AI router
        let aiPlan;
        try {
          // Point fetch to backend rest server API endpoint
          const res = await fetch(`${this.serverUrl.replace('/socket.io', '')}/api/ai/plan-step`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              htmlSnapshot,
              currentUrl,
              history,
              goal,
              persona
            })
          });
          aiPlan = await res.json();
        } catch (err) {
          console.error('Failed to get plan from AI service:', (err as Error).message);
          aiPlan = {
            action: 'FAIL',
            thought: 'Central AI Engine is unreachable or failed to return plan.',
            description: 'Aborting test due to server/AI engine connection failure.'
          };
        }

        console.log(`🤖 AI Decision: ${aiPlan.description}`);
        console.log(`💡 AI Thought: ${aiPlan.thought}`);
        if (aiPlan.selector) console.log(`🎯 Target Selector: ${aiPlan.selector}`);
        if (aiPlan.value) console.log(`📝 Input Value: ${aiPlan.value}`);

        if (aiPlan.action === 'COMPLETE') {
          console.log(`✅ AI indicated goal successfully completed!`);
          this.socket.emit('session-completed', { sessionId, status: 'PASSED' });
          running = false;
          break;
        }

        if (aiPlan.action === 'FAIL') {
          console.log(`❌ AI marked session run as FAILED!`);
          this.socket.emit('session-completed', { sessionId, status: 'FAILED' });
          running = false;
          break;
        }

        // Notify backend step execution started
        this.socket.emit('step-started', {
          sessionId,
          stepNumber,
          action: aiPlan.action,
          description: aiPlan.description
        });

        let stepError: string | undefined;
        let stepStatus: 'PASSED' | 'FAILED' = 'PASSED';
        let activeSelector = aiPlan.selector;
        let healed = false;
        let healingLog = '';

        try {
          // Perform Playwright action with self-healing wrapper
          const executeAction = async (selector: string) => {
            if (aiPlan.action === 'CLICK') {
              await page.waitForSelector(selector, { timeout: 4000 }); // Trigger faster healing on timeout
              await page.click(selector);
            } else if (aiPlan.action === 'TYPE') {
              await page.waitForSelector(selector, { timeout: 4000 });
              await page.fill(selector, aiPlan.value || '');
            }
          };

          if (aiPlan.action === 'CLICK' || aiPlan.action === 'TYPE') {
            try {
              await executeAction(activeSelector);
            } catch (err) {
              console.log(`⚠️ Locator timed out: "${activeSelector}". Attempting self-healing...`);
              
              // Get current interactive DOM layout snapshot for AI context
              const DOMSnapshot = await page.evaluate(() => {
                const interactiveTags = ['a', 'button', 'input', 'select', 'textarea'];
                const elements = Array.from(document.querySelectorAll('*')) as HTMLElement[];
                const interactiveNodes = elements.filter((el: any) => {
                  const tagName = el.tagName.toLowerCase();
                  const isInteractiveTag = interactiveTags.includes(tagName);
                  const style = window.getComputedStyle(el);
                  const hasCursorPointer = style.cursor === 'pointer';
                  const isBtnRole = el.getAttribute('role') === 'button';
                  const isVisible = el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
                  return isVisible && (isInteractiveTag || hasCursorPointer || isBtnRole);
                });
                return interactiveNodes.map((el: any) => {
                  const tagName = el.tagName.toLowerCase();
                  const id = el.id ? ` id="${el.id}"` : '';
                  const rawClass = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
                  const className = rawClass ? ` class="${rawClass.split(' ').slice(0, 2).join(' ')}"` : '';
                  const type = el.getAttribute('type') ? ` type="${el.getAttribute('type')}"` : '';
                  const text = el.textContent?.trim().slice(0, 30).replace(/[\n\r]/g, '') || '';
                  return `<${tagName}${id}${className}${type}>${text}</${tagName}>`;
                }).join('\n');
              });

              // Ask central server AI healer to heal selector
              const healerRes = await fetch(`${this.serverUrl.replace('/socket.io', '')}/api/ai/heal-selector`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  failedSelector: activeSelector,
                  htmlSnapshot: DOMSnapshot,
                  goal,
                  persona
                })
              });
              const healingResult = await healerRes.json();

              if (healingResult.healedSelector && healingResult.healedSelector !== activeSelector && healingResult.confidence > 0.4) {
                console.log(`🟢 Self-Healing Success! Replaced "${activeSelector}" -> "${healingResult.healedSelector}" (Confidence: ${Math.round(healingResult.confidence * 100)}%)`);
                console.log(`💡 Healing Reason: ${healingResult.reasoning}`);
                activeSelector = healingResult.healedSelector;
                healed = true;
                healingLog = `[Self-Healed: Replaced "${aiPlan.selector}" with "${activeSelector}" due to element update. Confidence: ${Math.round(healingResult.confidence * 100)}%]`;
                
                // Retry action with healed selector
                await executeAction(activeSelector);
              } else {
                throw new Error(`Self-healing failed. Original timeout error: ${(err as Error).message}`);
              }
            }
          } else if (aiPlan.action === 'ASSERTION') {
            await page.waitForFunction(
              (text) => document.body.innerText.includes(text),
              aiPlan.value || '',
              { timeout: 8000 }
            );
          }

          // Slight delay between interactions to let page load/settle
          await page.waitForTimeout(1500);
        } catch (err) {
          console.error(`Step Execution Error:`, (err as Error).message);
          stepStatus = 'FAILED';
          stepError = (err as Error).message;
        }

        // Capture console issues during this step execution
        if (consoleLogs.length > 0) {
          if (!stepError && consoleLogs.some(log => log.includes('[ERROR]') || log.includes('[CRASH]'))) {
            stepStatus = 'FAILED';
            stepError = `Console Errors detected:\n` + consoleLogs.join('\n');
          }
          // Reset logs
          consoleLogs.length = 0;
        }

        // Evaluate Accessibility checklist
        let a11yViolationsString: string | undefined;
        try {
          const violationsList = await page.evaluate(() => {
            const list: Array<{ rule: string; impact: string; description: string; element: string }> = [];
            
            // 1. Image alt attributes
            const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
            imgs.forEach((img, idx) => {
              if (!img.hasAttribute('alt') || img.getAttribute('alt')?.trim() === '') {
                list.push({
                  rule: 'Image Alt Text Missing',
                  impact: 'moderate',
                  description: `Image at index ${idx} is missing alternative descriptive text.`,
                  element: img.outerHTML.slice(0, 100)
                });
              }
            });

            // 2. Input associated labels / placeholders
            const inputs = Array.from(document.querySelectorAll('input, select, textarea')) as HTMLInputElement[];
            inputs.forEach((el) => {
              const hasLabel = el.id && document.querySelector(`label[for="${el.id}"]`);
              const hasPlaceholder = el.getAttribute('placeholder');
              const hasAria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
              if (!hasLabel && !hasPlaceholder && !hasAria && el.type !== 'submit' && el.type !== 'button' && el.type !== 'hidden') {
                list.push({
                  rule: 'Form Label Association Missing',
                  impact: 'serious',
                  description: `Input field (type="${el.type || 'text'}") lacks an associated label, placeholder, or aria-label descriptor.`,
                  element: el.outerHTML.slice(0, 100)
                });
              }
            });

            // 3. Empty buttons text
            const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
            buttons.forEach((btn) => {
              const text = btn.textContent?.trim();
              const hasAria = btn.getAttribute('aria-label');
              if (!text && !hasAria) {
                list.push({
                  rule: 'Button Name Descriptor Missing',
                  impact: 'critical',
                  description: 'Interactive button has no text content or aria-label description.',
                  element: btn.outerHTML.slice(0, 100)
                });
              }
            });

            return list;
          });

          if (violationsList.length > 0) {
            a11yViolationsString = JSON.stringify(violationsList);
            console.log(`♿ Accessibility Check: Found ${violationsList.length} compliance warnings.`);
          }
        } catch (e) {
          console.error('Failed to evaluate accessibility script:', e);
        }

        currentUrl = page.url();
        const stepScreenshot = (await page.screenshot({ type: 'png' })).toString('base64');

        this.socket.emit('step-completed', {
          sessionId,
          stepNumber,
          action: aiPlan.action,
          description: healed ? `${healingLog} ${aiPlan.description}` : aiPlan.description,
          status: stepStatus,
          error: stepError,
          selector: activeSelector,
          value: aiPlan.value,
          screenshotBase64: stepScreenshot,
          a11yViolations: a11yViolationsString,
          networkRequests: [...networkRequests]
        });

        history.push({
          stepNumber,
          action: aiPlan.action,
          description: aiPlan.description,
          status: stepStatus,
          error: stepError
        });

        networkRequests.length = 0;

        if (stepStatus === 'FAILED') {
          console.log(`❌ Step execution failed. Aborting further steps.`);
          this.socket.emit('session-completed', { sessionId, status: 'FAILED' });
          running = false;
          break;
        }

        stepNumber++;
      }

      if (stepNumber > maxSteps && running) {
        console.log(`⚠️ Exceeded max steps (${maxSteps}). Forcing run failure.`);
        this.socket.emit('session-completed', { sessionId, status: 'FAILED' });
      }

    } catch (err) {
      console.error('Fatal crash during test session execution:', err);
      this.socket.emit('session-completed', {
        sessionId,
        status: 'FAILED'
      });
    } finally {
      await this.browser.close();
      console.log('🔌 Local browser context closed.');
    }
  }
}
