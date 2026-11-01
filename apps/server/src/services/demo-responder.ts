import type { MockResponder } from '@ghostiq/llm';
import {
  GENERATE_TOKEN,
  parseAriaSnapshot,
  type HistoryItem,
  type SnapshotElement,
} from '@ghostiq/shared';

/**
 * Scripted answers for demo mode (no LLM configured) and for tests. It logs in to the
 * mock app by reading the real aria snapshot, so the whole pipeline (refs, guardrails,
 * evidence, metering) runs without a key. Everything it produces is labelled "[demo]".
 * It is not AI.
 */
export const demoResponder: MockResponder = (request) => {
  const meta = request.metadata ?? {};
  switch (request.purpose) {
    case 'health-check':
      return { ok: true };
    case 'next-action':
      return demoNextAction(
        String(meta.snapshot ?? ''),
        Array.isArray(meta.history) ? (meta.history as HistoryItem[]) : [],
      );
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

function find(elements: SnapshotElement[], role: string, name: RegExp) {
  return elements.find((e) => e.role === role && name.test(e.name));
}

/**
 * Walks the mock app login. The email is fixed so the smoke test can assert it; the
 * password uses <generate>, so personas with non-valid input strategies get their own
 * generated values from the agent core.
 */
function demoNextAction(snapshot: string, history: HistoryItem[]) {
  const elements = [...parseAriaSnapshot(snapshot).values()];
  const email = find(elements, 'textbox', /e-?mail/i);
  const password = find(elements, 'textbox', /password/i);
  const submit = find(elements, 'button', /sign in|log ?in|submit/i);
  const done = (kind: string, label: RegExp) =>
    history.some((h) => h.kind === kind && h.status === 'PASSED' && label.test(h.summary));

  if (email && !done('FILL', /mail/i)) {
    return {
      type: 'fill',
      ref: email.ref,
      text: 'testuser@ghostiq.io',
      reason: '[demo] fill the email field',
    };
  }
  if (password && !done('FILL', /password/i)) {
    return {
      type: 'fill',
      ref: password.ref,
      text: GENERATE_TOKEN,
      reason: '[demo] fill the password',
    };
  }
  if (submit && !done('CLICK', /sign in|log ?in|submit/i)) {
    return { type: 'click', ref: submit.ref, reason: '[demo] submit the login form' };
  }
  const loggedIn = history.some((h) => h.kind === 'CLICK' && h.status === 'PASSED');
  return {
    type: 'finish',
    goalMet: loggedIn,
    summary: loggedIn
      ? '[demo] Submitted the login form. Configure an LLM for real exploration.'
      : '[demo] No login form found; the demo script only knows the mock app.',
    reason: '[demo] script complete',
  };
}
