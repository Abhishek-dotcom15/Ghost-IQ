import type { MockResponder } from '@ghostiq/llm';

/**
 * Scripted answers for demo mode (no LLM configured) and for tests. It walks the
 * mock app's login form so the whole pipeline can be exercised without a key.
 * Everything it produces is labelled "[demo]". It is not AI.
 */
export const demoResponder: MockResponder = (request) => {
  const meta = request.metadata ?? {};
  switch (request.purpose) {
    case 'health-check':
      return { ok: true };
    case 'plan-step':
      return demoPlan(meta);
    case 'heal-selector':
      return demoHeal(String(meta.failedSelector ?? ''));
    case 'diagnostics':
      return {
        summary:
          '[demo] Demo mode cannot analyse failures. Configure an LLM provider for a real report.',
        rootCause: 'Unknown (demo mode).',
        failedStep: null,
        evidence: [],
        recommendedFixes: ['Set GHOSTIQ_LLM_PROVIDER and an API key, then re-run.'],
        confidence: 'low',
      };
    default:
      throw new Error(`Demo responder has no script for purpose "${request.purpose}"`);
  }
};

interface HistoryEntry {
  action?: unknown;
}

function demoPlan(meta: Record<string, unknown>) {
  const history = Array.isArray(meta.history) ? (meta.history as HistoryEntry[]) : [];
  // The initial navigation is recorded as a GOTO step; it is not a planner decision.
  const decisions = history.filter((h) => h.action !== 'GOTO').length;
  const snapshot = String(meta.htmlSnapshot ?? '');
  const persona = String(meta.persona ?? '');
  // The mock app's email field is <input type="text" id="email">, so match by id/name/type.
  const hasLoginForm = /id="email"|name="email"|type="email"|type="password"/i.test(snapshot);

  if (!hasLoginForm && decisions === 0) {
    return {
      action: 'COMPLETE',
      thought: 'Demo script only knows the login form of the mock app.',
      description: '[demo] No login form found; demo script finished',
    };
  }

  switch (decisions) {
    case 0:
      return {
        action: 'TYPE',
        selector: 'input#email, input[type="email"]',
        value: persona === 'Form Stress Tester' ? 'invalid-email-format' : 'testuser@ghostiq.io',
        thought: 'Scripted demo: fill the email field.',
        description: '[demo] Typing email into the login form',
      };
    case 1:
      return {
        action: 'TYPE',
        selector: 'input[type="password"]',
        value: 'password123',
        thought: 'Scripted demo: fill the password field.',
        description: '[demo] Typing password',
      };
    case 2:
      return {
        action: 'CLICK',
        selector: 'button[type="submit"]',
        thought: 'Scripted demo: submit the form.',
        description: '[demo] Clicking submit',
      };
    default:
      return {
        action: 'COMPLETE',
        thought: 'Scripted demo finished.',
        description: '[demo] Demo script complete (configure an LLM for real exploration)',
      };
  }
}

function demoHeal(failedSelector: string) {
  if (failedSelector.includes('submit-btn')) {
    return {
      healedSelector: 'button[type="submit"]',
      confidence: 0.9,
      reasoning: '[demo] Scripted heal for the mock app submit button.',
    };
  }
  return {
    healedSelector: failedSelector,
    confidence: 0,
    reasoning: '[demo] No scripted heal available.',
  };
}
