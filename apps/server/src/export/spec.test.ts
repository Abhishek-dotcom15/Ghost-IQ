import { InputGenerator, deriveSeed } from '@ghostiq/personas';
import { PersonaSpec } from '@ghostiq/shared';
import { describe, expect, it } from 'vitest';
import { exportPlaywrightSpec, regenerateValues, type RecordedStep } from './spec.js';

const persona = PersonaSpec.parse({
  id: 'tester',
  name: 'Tester',
  description: 'd',
  input_strategy: 'mixed',
});

const session = {
  id: 'run-1',
  name: 'Tester: Log in',
  targetUrl: 'http://shop.test/',
  persona: 'Tester',
  personaJson: JSON.stringify(persona),
  seed: 7,
  goal: 'Log in',
  startedAt: new Date('2026-11-02T10:00:00Z'),
};

const loc = (role: string, name: string, ref = 'e1') =>
  JSON.stringify({ ref, role, name, code: null });
const step = (n: number, partial: Partial<RecordedStep>): RecordedStep => ({
  stepNumber: n,
  action: 'CLICK',
  description: `step ${n}`,
  status: 'PASSED',
  value: null,
  url: 'http://shop.test/',
  actionJson: null,
  locatorJson: null,
  inputJson: null,
  behavior: null,
  ...partial,
});

const steps: RecordedStep[] = [
  step(1, { action: 'GOTO', description: 'Open http://shop.test/' }),
  step(2, {
    action: 'FILL',
    value: 'qa@corp.test',
    actionJson: JSON.stringify({ type: 'fill', ref: 'e9', text: 'qa@corp.test', reason: 'x' }),
    locatorJson: loc('textbox', 'Email address', 'e9'),
  }),
  step(3, {
    action: 'FILL',
    value: '••••••',
    actionJson: JSON.stringify({ type: 'fill', ref: 'e11', text: '••••••', reason: 'x' }),
    locatorJson: loc('textbox', 'Password', 'e11'),
    inputJson: JSON.stringify({ strategy: 'valid', kind: 'password', field: 'Password' }),
  }),
  step(4, {
    action: 'CLICK',
    description: 'Click button "Sign In"',
    actionJson: JSON.stringify({ type: 'click', ref: 'e12', reason: 'x' }),
    locatorJson: loc('button', 'Sign In', 'e12'),
    url: 'http://shop.test/dashboard',
  }),
  step(5, {
    action: 'CLICK',
    status: 'FAILED',
    actionJson: JSON.stringify({ type: 'click', ref: 'e3', reason: 'x' }),
    locatorJson: loc('button', 'Gone', 'e3'),
  }),
  step(6, {
    action: 'CLICK',
    actionJson: JSON.stringify({ type: 'click', ref: 'e14', reason: 'x' }),
    locatorJson: loc('button', '', 'e14'),
    url: 'http://shop.test/dashboard',
  }),
  step(7, {
    action: 'NAVIGATE',
    actionJson: JSON.stringify({ type: 'navigate', path: '/cart', reason: 'x' }),
    url: 'http://shop.test/cart',
  }),
  step(8, {
    action: 'FILL',
    value: '2147483648',
    actionJson: JSON.stringify({ type: 'fill', ref: 'e20', text: '2147483648', reason: 'x' }),
    locatorJson: loc('spinbutton', 'Quantity', 'e20'),
    url: 'http://shop.test/cart',
  }),
];

describe('regenerateValues', () => {
  it('recovers masked generated values by replaying the seeded generator', () => {
    const values = regenerateValues(persona, 7, steps);
    const expected = new InputGenerator(deriveSeed(7, 'inputs')).value(
      { role: 'textbox', name: 'Password' },
      'mixed',
    );
    expect(values.get(3)).toBe(expected.value);
    expect(values.has(2)).toBe(false); // typed by the planner, recorded in clear
  });
});

describe('exportPlaywrightSpec', () => {
  const result = exportPlaywrightSpec(session, steps);

  it('produces a self-contained Playwright test with role locators', () => {
    expect(result.code).toContain("import { test, expect } from '@playwright/test';");
    expect(result.code).not.toMatch(/ghostiq\//i);
    expect(result.code).toContain('test("Log in", async ({ page }) => {');
    expect(result.code).toContain('await page.goto("http://shop.test/");');
    expect(result.code).toContain(
      'await page.getByRole("textbox", { name: "Email address", exact: true }).fill("qa@corp.test");',
    );
    expect(result.code).toContain(
      'await page.getByRole("button", { name: "Sign In", exact: true }).click();',
    );
  });

  it('fills masked generated values with the regenerated value, never the mask', () => {
    expect(result.code).not.toContain('••••••');
    const regenerated = regenerateValues(persona, 7, steps).get(3)!;
    expect(result.code).toContain(`.fill(${JSON.stringify(regenerated)});`);
    expect(result.secrets).toEqual([]);
  });

  it('asserts URL changes, types into number inputs, and skips what it cannot reproduce', () => {
    expect(result.code).toContain('await expect(page).toHaveURL("http://shop.test/dashboard");');
    expect(result.code).toContain('await page.goto("http://shop.test/cart");');
    expect(result.code).toContain('.pressSequentially("2147483648");');
    expect(result.code).toContain('// 5. step 5 [FAILED: not exported');
    expect(result.code).toContain('// 6. step 6 [not exported: the target has no accessible name');
    expect(result.skipped).toBe(2);
  });

  it('asks for an environment variable when a masked value was not generated', () => {
    const typedSecret = steps.map((s) => (s.stepNumber === 3 ? { ...s, inputJson: null } : s));
    const r = exportPlaywrightSpec(session, typedSecret);
    expect(r.secrets).toEqual(['GHOSTIQ_SECRET_3']);
    expect(r.code).toContain(".fill(process.env.GHOSTIQ_SECRET_3 ?? '');");
  });

  it('asserts the goal state the recording reached', () => {
    const r = exportPlaywrightSpec(
      {
        ...session,
        finalStateJson: JSON.stringify({
          url: 'http://shop.test/cart',
          headings: ['Your cart', 'Extras', 'More'],
        }),
      },
      steps,
    );
    expect(r.code).toContain(
      'await expect(page.getByRole("heading", { name: "Your cart", exact: true })).toBeVisible();',
    );
    expect(r.code).not.toContain('"More"');
  });

  it('uses approved heals instead of the recorded locator', () => {
    const r = exportPlaywrightSpec(
      session,
      steps,
      new Map([[4, { ref: 'e40', role: 'button', name: 'Log in', code: null }]]),
    );
    expect(r.code).toContain('page.getByRole("button", { name: "Log in", exact: true }).click();');
    expect(r.code).toContain('(locator from an approved heal)');
    expect(r.healed).toEqual([4]);
  });
});
