import { describe, expect, it } from 'vitest';
import {
  AgentAction,
  PlannerOutput,
  isAllowedUrl,
  isDestructiveName,
  isSecretField,
  locatorCode,
  parseAriaSnapshot,
  toAgentAction,
  toOrigin,
} from './index.js';

// Captured from the mock app with page.ariaSnapshot({ mode: 'ai' }) on Playwright 1.64.
const MOCK_APP_SNAPSHOT = `- generic [ref=e5]:
  - heading "App Secure Login" [level=2] [ref=e6]
  - generic [ref=e7]:
    - generic [ref=e8]: Email address
    - textbox "Email address" [active] [ref=e9]:
      - /placeholder: name@example.com
    - generic [ref=e10]: Password
    - textbox "Password" [ref=e11]:
      - /placeholder: Enter password
    - button "Sign In" [ref=e12] [cursor=pointer]
  - generic [ref=e13]:
    - textbox [ref=e14]
    - button [ref=e15] [cursor=pointer]
    - link "Say \\"hi\\"" [ref=f1e3]`;

describe('parseAriaSnapshot', () => {
  const elements = parseAriaSnapshot(MOCK_APP_SNAPSHOT);

  it('extracts role, name and attributes for every ref', () => {
    expect(elements.get('e12')).toEqual({
      ref: 'e12',
      role: 'button',
      name: 'Sign In',
      attributes: ['cursor=pointer'],
    });
    expect(elements.get('e9')).toMatchObject({
      role: 'textbox',
      name: 'Email address',
      attributes: ['active'],
    });
    expect(elements.get('e6')?.attributes).toEqual(['level=2']);
  });

  it('handles anonymous elements, escaped quotes and iframe refs', () => {
    expect(elements.get('e14')).toMatchObject({ role: 'textbox', name: '' });
    expect(elements.get('f1e3')).toMatchObject({ role: 'link', name: 'Say "hi"' });
  });

  it('skips lines without refs', () => {
    expect([...elements.keys()]).not.toContain(undefined);
    expect(elements.size).toBe(12);
  });
});

describe('locatorCode', () => {
  it('builds a role locator for named elements only', () => {
    expect(locatorCode({ role: 'button', name: 'Sign In' })).toBe(
      `page.getByRole("button", { name: "Sign In" })`,
    );
    expect(locatorCode({ role: 'textbox', name: '' })).toBeNull();
    expect(locatorCode({ role: 'generic', name: 'x' })).toBeNull();
  });
});

describe('guards', () => {
  it('allows only http(s) URLs on allowlisted origins', () => {
    const allowed = ['http://localhost:3000'];
    expect(isAllowedUrl('http://localhost:3000/dashboard?x=1', allowed)).toBe(true);
    expect(isAllowedUrl('http://localhost:3001/', allowed)).toBe(false);
    expect(isAllowedUrl('https://evil.example/', allowed)).toBe(false);
    expect(isAllowedUrl('javascript:alert(1)', allowed)).toBe(false);
    expect(isAllowedUrl('http://localhost:3000/', ['localhost:3000'])).toBe(true);
    expect(toOrigin('not a url %%')).toBeNull();
  });

  it('flags destructive controls but not ordinary ones', () => {
    for (const name of [
      'Delete account',
      'Remove item',
      'Pay now',
      'Place order',
      'Cancel subscription',
    ]) {
      expect(isDestructiveName(name), name).toBe(true);
    }
    for (const name of ['Sign In', 'Checkout', 'Cancel', 'Removed items', 'Payload viewer']) {
      expect(isDestructiveName(name), name).toBe(false);
    }
  });

  it('recognises secret fields', () => {
    expect(isSecretField('Password')).toBe(true);
    expect(isSecretField('API key')).toBe(true);
    expect(isSecretField('Email address')).toBe(false);
  });
});

describe('planner output', () => {
  it('converts a flat planner reply into the strict action, dropping stray fields', () => {
    const output = PlannerOutput.parse({
      type: 'fill',
      ref: 'e9',
      text: 'a@b.co',
      key: 'Enter',
      reason: 'enter email',
    });
    expect(toAgentAction(output)).toEqual({
      type: 'fill',
      ref: 'e9',
      text: 'a@b.co',
      reason: 'enter email',
    });
  });

  it('rejects replies missing what the action needs, with a useful message', () => {
    const result = PlannerOutput.safeParse({ type: 'click', reason: 'go' });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toContain('click');
  });

  it('rejects full-URL navigation and invented selectors', () => {
    expect(
      PlannerOutput.safeParse({ type: 'navigate', path: 'https://evil.example', reason: 'x' })
        .success,
    ).toBe(false);
    expect(
      PlannerOutput.safeParse({ type: 'click', ref: '#submit-btn', reason: 'x' }).success,
    ).toBe(false);
  });

  it('uses reason as the finish summary when summary is missing', () => {
    const output = PlannerOutput.parse({ type: 'finish', goalMet: true, reason: 'Logged in' });
    expect(toAgentAction(output)).toEqual({ type: 'finish', goalMet: true, summary: 'Logged in' });
  });

  it('keeps the action union closed', () => {
    expect(AgentAction.safeParse({ type: 'eval', code: 'alert(1)' }).success).toBe(false);
  });
});
