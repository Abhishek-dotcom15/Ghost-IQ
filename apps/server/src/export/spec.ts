import { InputGenerator, deriveSeed } from '@ghostiq/personas';
import {
  MASK,
  PersonaSpec,
  type AgentAction,
  type ElementLocator,
  type InputStrategy,
} from '@ghostiq/shared';

/** A recorded step as stored in the database. */
export interface RecordedStep {
  stepNumber: number;
  action: string;
  description: string;
  status: string;
  value: string | null;
  url: string | null;
  actionJson: string | null;
  locatorJson: string | null;
  inputJson: string | null;
  behavior: string | null;
}

export interface RecordedSession {
  id: string;
  name: string;
  targetUrl: string;
  persona: string;
  personaJson: string | null;
  seed: number | null;
  goal: string | null;
  startedAt: Date;
  /** FinalState JSON recorded when the goal was met. */
  finalStateJson?: string | null;
}

/**
 * Recovers generated form values that were masked in storage (passwords and the like).
 * Generated values depend only on the seed, the field and how often it was filled, so
 * replaying the generator over the run's generated fills, in order, yields the same values.
 */
export function regenerateValues(
  persona: PersonaSpec | null,
  seed: number | null,
  steps: RecordedStep[],
): Map<number, string> {
  const values = new Map<number, string>();
  if (!persona || seed === null) return values;
  const generator = new InputGenerator(deriveSeed(seed, 'inputs'));
  for (const step of [...steps].sort((a, b) => a.stepNumber - b.stepNumber)) {
    if (!step.inputJson || !step.locatorJson) continue;
    const locator = JSON.parse(step.locatorJson) as ElementLocator;
    const generated = generator.value(
      { role: locator.role, name: locator.name },
      persona.input_strategy as InputStrategy,
    );
    values.set(step.stepNumber, generated.value);
  }
  return values;
}

export interface ExportResult {
  code: string;
  /** Steps that could not be exported (no accessible name, failed in the recording, ...). */
  skipped: number;
  /** Environment variables the spec expects for secrets that cannot be regenerated. */
  secrets: string[];
  /** Steps whose locator comes from an approved heal. */
  healed: number[];
}

/**
 * Turns a recorded run into a readable Playwright test with role-based locators.
 * The output depends only on @playwright/test: no GhostIQ, no LLM.
 */
export function exportPlaywrightSpec(
  session: RecordedSession,
  steps: RecordedStep[],
  overrides: Map<number, ElementLocator> = new Map(),
): ExportResult {
  const persona = session.personaJson
    ? PersonaSpec.safeParse(JSON.parse(session.personaJson))
    : null;
  const regenerated = regenerateValues(persona?.success ? persona.data : null, session.seed, steps);
  const ordered = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);
  const body: string[] = [];
  const secrets: string[] = [];
  const healed: number[] = [];
  let skipped = 0;
  let previousUrl: string | null = null;

  for (const step of ordered) {
    const label = `${step.stepNumber}. ${oneLine(step.description)}`;

    if (step.action === 'GOTO') {
      body.push(`  // ${label}`, `  await page.goto(${str(session.targetUrl)});`);
      previousUrl = step.url ?? session.targetUrl;
      continue;
    }
    if (step.status !== 'PASSED') {
      body.push(
        `  // ${label} [${step.status}: not exported, it did not succeed in the recording]`,
      );
      skipped++;
      continue;
    }
    const action = step.actionJson ? (JSON.parse(step.actionJson) as AgentAction) : null;
    if (!action) {
      body.push(`  // ${label} [not exported: no recorded action]`);
      skipped++;
      continue;
    }

    const override = overrides.get(step.stepNumber);
    const recorded = step.locatorJson ? (JSON.parse(step.locatorJson) as ElementLocator) : null;
    const locator = override ?? recorded;
    if (override) healed.push(step.stepNumber);

    const lines = statementFor(action, locator, step, session, regenerated, secrets);
    if (!lines) {
      body.push(
        `  // ${label} [not exported: the target has no accessible name, so it has no stable locator. Give it a label.]`,
      );
      skipped++;
      continue;
    }
    body.push(
      `  // ${label}${override ? ' (locator from an approved heal)' : ''}${step.behavior ? ` [persona behavior: ${step.behavior}]` : ''}`,
    );
    body.push(...lines.map((l) => `  ${l}`));

    // Where the recording ended up after this action. Never healed: a different URL is a regression.
    if (step.url && /^https?:/.test(step.url) && step.url !== previousUrl) {
      body.push(`  await expect(page).toHaveURL(${str(step.url)});`);
    }
    if (step.url && /^https?:/.test(step.url)) previousUrl = step.url;
  }

  // The goal state the recording reached: without this the test would pass even if the
  // flow silently failed.
  if (session.finalStateJson) {
    const final = JSON.parse(session.finalStateJson) as { url: string; headings: string[] };
    body.push('  // Goal reached in the recording: assert the same end state.');
    if (/^https?:/.test(final.url) && final.url !== previousUrl) {
      body.push(`  await expect(page).toHaveURL(${str(final.url)});`);
    }
    for (const heading of final.headings.slice(0, 2)) {
      body.push(
        `  await expect(page.getByRole("heading", { name: ${str(heading)}, exact: true })).toBeVisible();`,
      );
    }
  }

  const header = [
    '// Exported by GhostIQ. Plain Playwright: run with `npx playwright test`.',
    `// Source run: ${session.id} · persona: ${session.persona} · seed: ${session.seed ?? '-'} · recorded ${session.startedAt.toISOString()}`,
    '// Locators use roles and accessible names, so the test survives most markup changes.',
    ...(secrets.length
      ? [`// Secrets typed in the recording are not stored. Set: ${secrets.join(', ')}`]
      : []),
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${str(session.goal ?? session.name)}, async ({ page }) => {`,
  ];
  return { code: [...header, ...body, '});', ''].join('\n'), skipped, secrets, healed };
}

function statementFor(
  action: AgentAction,
  locator: ElementLocator | null,
  step: RecordedStep,
  session: RecordedSession,
  regenerated: Map<number, string>,
  secrets: string[],
): string[] | null {
  const target = () => (locator?.name ? byRole(locator) : null);
  switch (action.type) {
    case 'click': {
      const t = target();
      return t ? [`await ${t}.click();`] : null;
    }
    case 'hover': {
      const t = target();
      return t ? [`await ${t}.hover();`] : null;
    }
    case 'select': {
      const t = target();
      return t ? [`await ${t}.selectOption(${str(action.option)});`] : null;
    }
    case 'fill': {
      const t = target();
      if (!t) return null;
      let value: string;
      if (step.value === MASK) {
        const recovered = regenerated.get(step.stepNumber);
        if (recovered !== undefined) {
          value = str(recovered);
        } else {
          const name = `GHOSTIQ_SECRET_${step.stepNumber}`;
          secrets.push(name);
          value = `process.env.${name} ?? ''`;
        }
      } else {
        value = str(step.value ?? '');
      }
      // Number inputs reject fill() with non-numeric text: type it like a user would.
      return locator?.role === 'spinbutton'
        ? [`await ${t}.clear();`, `await ${t}.pressSequentially(${value});`]
        : [`await ${t}.fill(${value});`];
    }
    case 'press':
      return [`await page.keyboard.press(${str(action.key)});`];
    case 'scroll':
      return [`await page.mouse.wheel(0, ${action.direction === 'down' ? 600 : -600});`];
    case 'goBack':
      return ['await page.goBack();'];
    case 'goForward':
      return ['await page.goForward();'];
    case 'reload':
      return ['await page.reload();'];
    case 'navigate':
      return [`await page.goto(${str(new URL(action.path, session.targetUrl).toString())});`];
    case 'wait':
      return [`await page.waitForTimeout(${action.ms});`];
    case 'finish':
      return [];
  }
}

function byRole(locator: ElementLocator): string {
  return `page.getByRole(${str(locator.role)}, { name: ${str(locator.name)}, exact: true })`;
}

/** A TypeScript string literal (JSON escaping is valid TS). */
function str(value: string): string {
  return JSON.stringify(value);
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').slice(0, 200);
}
