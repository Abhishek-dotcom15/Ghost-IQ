import type { MockResponder } from '@ghostiq/llm';
import {
  GENERATE_TOKEN,
  isDestructiveName,
  parseAriaSnapshot,
  type HistoryItem,
  type PersonaBrief,
  type SnapshotElement,
} from '@ghostiq/shared';

/**
 * Scripted answers for demo mode (no LLM configured) and for tests. Everything it produces
 * is labelled "[demo]". It is not AI:
 *
 * - Login goals walk the mock app's login form (what the smoke test checks).
 * - Exploration goals ("explore", "find", "stress", ...) run a systematic crawler: fill
 *   every field with persona-generated values, click every control, follow every link,
 *   wait on loading spinners. That makes the oracle benchmark deterministic.
 */
export const demoResponder: MockResponder = (request) => {
  const meta = request.metadata ?? {};
  switch (request.purpose) {
    case 'health-check':
      return { ok: true };
    case 'next-action': {
      const snapshot = String(meta.snapshot ?? '');
      const history = Array.isArray(meta.history) ? (meta.history as HistoryItem[]) : [];
      const goal = String(meta.goal ?? '');
      if (EXPLORE_GOAL.test(goal)) {
        return crawl({
          sessionId: String(meta.sessionId ?? ''),
          snapshot,
          url: String(meta.url ?? ''),
          history,
          persona: meta.persona as PersonaBrief | undefined,
          allowDestructive: meta.allowDestructive === true,
        });
      }
      return demoLogin(snapshot, history);
    }
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

const EXPLORE_GOAL = /\b(explore|exploring|crawl|find|stress|check every|everything|whole app)\b/i;

function find(elements: SnapshotElement[], role: string, name: RegExp) {
  return elements.find((e) => e.role === role && name.test(e.name));
}

/**
 * Walks the mock app login. The email is fixed so the smoke test can assert it; the
 * password uses <generate>, so personas with non-valid input strategies get their own
 * generated values from the agent core.
 */
function demoLogin(snapshot: string, history: HistoryItem[]) {
  const elements = [...parseAriaSnapshot(snapshot).values()];
  const step = loginStep(elements, history);
  if (step) return step;
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

function loginStep(elements: SnapshotElement[], history: HistoryItem[]) {
  const email = find(elements, 'textbox', /e-?mail/i);
  const password = find(elements, 'textbox', /password/i);
  const submit = find(elements, 'button', /sign in|log ?in/i);
  if (!email || !password || !submit) return null;
  const done = (kind: string, label: RegExp) =>
    history.some((h) => h.kind === kind && h.status === 'PASSED' && label.test(h.summary));
  if (!done('FILL', /mail/i)) {
    return {
      type: 'fill',
      ref: email.ref,
      text: 'testuser@ghostiq.io',
      reason: '[demo] fill the email field',
    };
  }
  if (!done('FILL', /password/i)) {
    return {
      type: 'fill',
      ref: password.ref,
      text: GENERATE_TOKEN,
      reason: '[demo] fill the password',
    };
  }
  if (!done('CLICK', /sign in|log ?in/i)) {
    return { type: 'click', ref: submit.ref, reason: '[demo] submit the login form' };
  }
  return null;
}

// ---------------------------------------------------------------- crawler

interface CrawlState {
  /** Controls already used, keyed by page path + role + name. */
  done: Set<string>;
  visited: Set<string>;
  discovered: string[];
  waits: Map<string, number>;
  probes: string[];
}

/** Per-run crawler memory. The planner only sees the last few steps; the crawler needs all. */
const crawls = new Map<string, CrawlState>();
const MAX_CRAWLS = 200;

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);
const CLICK_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem']);
/** Paths a curious (or malicious) user guesses; only the security persona tries them. */
const SECURITY_PROBES = ['/admin', '/api/debug', '/account/2'];
const MAX_WAITS_PER_PAGE = 2;

function stateFor(sessionId: string, persona?: PersonaBrief): CrawlState {
  let state = crawls.get(sessionId);
  if (!state) {
    if (crawls.size >= MAX_CRAWLS) crawls.delete(crawls.keys().next().value!);
    state = {
      done: new Set(),
      visited: new Set(),
      discovered: [],
      waits: new Map(),
      probes: persona?.id === 'security-hygiene' ? [...SECURITY_PROBES] : [],
    };
    crawls.set(sessionId, state);
  }
  return state;
}

/** Same-site link destinations by ref: AI snapshots put "- /url: ..." under each link. */
function linkTargets(snapshot: string, current: URL): Map<string, string> {
  const targets = new Map<string, string>();
  let lastLinkRef: string | null = null;
  for (const line of snapshot.split('\n')) {
    const link = /-\s+link\b.*\[ref=([\w]+)\]/.exec(line);
    if (link) {
      lastLinkRef = link[1]!;
      continue;
    }
    const url = /\/url:\s*(\S+)/.exec(line);
    if (url && lastLinkRef) {
      try {
        const target = new URL(url[1]!, current);
        if (target.origin === current.origin) targets.set(lastLinkRef, target.pathname);
      } catch {
        // ignore malformed hrefs
      }
      lastLinkRef = null;
    } else if (/\[ref=/.test(line)) {
      lastLinkRef = null;
    }
  }
  return targets;
}

function crawl(input: {
  sessionId: string;
  snapshot: string;
  url: string;
  history: HistoryItem[];
  persona?: PersonaBrief;
  allowDestructive: boolean;
}) {
  const state = stateFor(input.sessionId, input.persona);
  let current: URL;
  try {
    current = new URL(input.url);
  } catch {
    return {
      type: 'finish',
      goalMet: false,
      summary: '[demo] no page to explore',
      reason: '[demo] done',
    };
  }
  const path = current.pathname;
  state.visited.add(path);
  const allowed = input.persona?.allowed_actions;
  const may = (type: string) => !allowed || allowed.includes(type);

  // Remember every same-site link on the page (the AI snapshot lists hrefs as "/url:" lines).
  for (const match of input.snapshot.matchAll(/\/url:\s*(\S+)/g)) {
    try {
      const target = new URL(match[1]!, current);
      if (target.origin === current.origin && !state.discovered.includes(target.pathname)) {
        state.discovered.push(target.pathname);
      }
    } catch {
      // ignore malformed hrefs
    }
  }

  const elements = [...parseAriaSnapshot(input.snapshot).values()];
  const login = loginStep(elements, input.history);
  if (login && may(login.type)) return login;

  // A spinner is showing: wait like a patient user would (this is how hangs surface).
  const waits = state.waits.get(path) ?? 0;
  if (
    /\b(loading|please wait)\b/i.test(input.snapshot) &&
    waits < MAX_WAITS_PER_PAGE &&
    may('wait')
  ) {
    state.waits.set(path, waits + 1);
    return { type: 'wait', ms: 4500, reason: '[demo] content is still loading' };
  }

  const key = (e: SnapshotElement) => `${path}|${e.role}|${e.name || `#${e.ref}`}`;
  const fresh = (e: SnapshotElement) => !state.done.has(key(e));

  const field = elements.find((e) => FIELD_ROLES.has(e.role) && fresh(e));
  if (field && may('fill')) {
    state.done.add(key(field));
    return { type: 'fill', ref: field.ref, text: GENERATE_TOKEN, reason: '[demo] try this field' };
  }

  // Buttons before links, so forms are submitted before the crawler leaves the page.
  // Links to pages already visited are skipped: they only lead back.
  const targets = linkTargets(input.snapshot, current);
  const usable = (e: SnapshotElement) =>
    CLICK_ROLES.has(e.role) &&
    fresh(e) &&
    (input.allowDestructive || !isDestructiveName(e.name)) &&
    !(e.role === 'link' && state.visited.has(targets.get(e.ref) ?? '\0'));
  const control =
    elements.find((e) => usable(e) && e.role !== 'link') ?? elements.find((e) => usable(e));
  if (control && may('click')) {
    state.done.add(key(control));
    const target = targets.get(control.ref);
    if (target) state.visited.add(target);
    return { type: 'click', ref: control.ref, reason: `[demo] try ${control.role}` };
  }
  if (control && !may('click') && may('press')) {
    // Keyboard-only: move focus and activate instead of clicking.
    state.done.add(key(control));
    return { type: 'press', key: 'Tab', reason: '[demo] keyboard: move focus' };
  }

  const next =
    state.probes.shift() ?? state.discovered.find((p) => !state.visited.has(p) && p !== path);
  if (next && may('navigate')) {
    state.visited.add(next);
    return { type: 'navigate', path: next, reason: '[demo] explore the next page' };
  }

  crawls.delete(input.sessionId);
  return {
    type: 'finish',
    goalMet: true,
    summary: `[demo] Explored ${state.visited.size} page(s) and every control on them.`,
    reason: '[demo] crawl complete',
  };
}
