import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InputGenerator,
  createRng,
  deriveSeed,
  inferFieldKind,
  loadBuiltinPersonas,
  parsePersona,
  planBehaviors,
  resolveDevice,
  resolveNetwork,
  sampleInputs,
} from './index.js';

describe('built-in personas', () => {
  const builtins = loadBuiltinPersonas();

  it('ships eight valid personas whose file name matches the id', () => {
    expect(builtins).toHaveLength(8);
    for (const { persona, source } of builtins) {
      expect(path.basename(source, '.yaml')).toBe(persona.id);
    }
    expect(new Set(builtins.map((b) => b.persona.id)).size).toBe(8);
  });

  it('applies defaults and keeps the security persona safe and opt-in', () => {
    const security = builtins.find((b) => b.persona.id === 'security-hygiene')!.persona;
    expect(security).toMatchObject({ requires_consent: true, risk_tolerance: 'safe' });
    const keyboard = builtins.find((b) => b.persona.id === 'keyboard-only')!.persona;
    expect(keyboard.allowed_actions).not.toContain('click');
  });
});

describe('parsePersona', () => {
  const VALID = `id: my-persona
name: My Persona
description: Test persona.
`;

  it('accepts a minimal persona and fills defaults', () => {
    const result = parsePersona(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.persona).toMatchObject({
        input_strategy: 'valid',
        pacing: { min_ms: 200, max_ms: 800 },
        device: 'laptop',
        network: 'none',
        seed: 42,
        behaviors: [],
      });
    }
  });

  it('reports wrong values with the line they are on', () => {
    const result = parsePersona(`${VALID}input_strategy: random
behaviors:
  - { type: double_click, probability: 1.5 }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ line: 4, path: 'input_strategy' }),
        expect.objectContaining({ line: 6, path: 'behaviors.0.probability' }),
      ]);
    }
  });

  it('points at misspelled keys', () => {
    const result = parsePersona(`${VALID}pacing:
  min_ms: 100
  maxms: 200
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ line: 6, path: 'pacing.maxms' });
      expect(result.errors[0]!.message).toContain('Unknown field "maxms"');
    }
  });

  it('reports YAML syntax errors and cross-field rules', () => {
    const syntax = parsePersona('id: x\nname: [unclosed\n');
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) expect(syntax.errors[0]!.line).not.toBeNull();

    const pacing = parsePersona(`${VALID}pacing: { min_ms: 900, max_ms: 100 }\n`);
    expect(pacing.ok).toBe(false);
    if (!pacing.ok)
      expect(pacing.errors[0]).toMatchObject({ line: 4, message: 'min_ms must be <= max_ms' });
  });

  it('accepts JSON too', () => {
    expect(parsePersona('{"id":"json-p","name":"J","description":"d"}').ok).toBe(true);
  });
});

describe('InputGenerator', () => {
  const email = { role: 'textbox', name: 'Email address' };
  const password = { role: 'textbox', name: 'Password' };

  it('is reproducible: same seed and fields give the same values, in any order', () => {
    const a = new InputGenerator(42);
    const b = new InputGenerator(42);
    const aEmail = a.value(email, 'valid').value;
    const aPassword = a.value(password, 'valid').value;
    // b fills the fields in the opposite order
    const bPassword = b.value(password, 'valid').value;
    const bEmail = b.value(email, 'valid').value;
    expect(aEmail).toBe(bEmail);
    expect(aPassword).toBe(bPassword);
    expect(aEmail).toMatch(/^[a-z]+\.[a-z]+\d+@example\.test$/);
  });

  it('changes with the seed and with repeated fills of the same field', () => {
    const g = new InputGenerator(42);
    const first = g.value(email, 'valid').value;
    const second = g.value(email, 'valid').value;
    expect(first).not.toBe(second);
    expect(new InputGenerator(43).value(email, 'valid').value).not.toBe(first);
  });

  it('produces strategy-specific values', () => {
    const g = new InputGenerator(1);
    expect(g.value(email, 'empty').value).toBe('');
    const naughty = sampleInputs(5, 'naughty_strings', 3).map((s) => s.value);
    expect(naughty.some((v) => /[<'{$%]/.test(v))).toBe(true);
    const unicode = sampleInputs(5, 'unicode', 3).map((s) => s.value);
    const nonAscii = (v: string) => [...v].some((ch) => ch.codePointAt(0)! > 127);
    expect(unicode.some(nonAscii)).toBe(true);
    const mixed = sampleInputs(9, 'mixed', 4);
    expect(new Set(mixed.map((s) => s.strategy)).size).toBeGreaterThan(1);
    expect(mixed.every((s) => s.strategy !== 'mixed')).toBe(true);
  });

  it('infers field kinds from accessible names and roles', () => {
    expect(inferFieldKind(email)).toBe('email');
    expect(inferFieldKind(password)).toBe('password');
    expect(inferFieldKind({ role: 'spinbutton', name: 'Qty' })).toBe('number');
    expect(inferFieldKind({ role: 'searchbox', name: '' })).toBe('search');
    expect(inferFieldKind({ role: 'textbox', name: 'Phone number' })).toBe('phone');
    expect(inferFieldKind({ role: 'textbox', name: 'Comment' })).toBe('text');
  });
});

describe('planBehaviors', () => {
  const click = { type: 'click' as const, ref: 'e3', reason: 'submit' };

  it('fires behaviors by probability and is reproducible for a seed', () => {
    const behaviors = [
      { type: 'double_click' as const, probability: 0.5 },
      { type: 'refresh_mid_flow' as const, probability: 0.5 },
    ];
    const run = (seed: number) => {
      const rng = createRng(deriveSeed(seed, 'behaviors'));
      return Array.from({ length: 20 }, () =>
        planBehaviors(behaviors, click, rng).map((s) => s.behavior),
      );
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
    expect(run(7).flat()).toEqual(expect.arrayContaining(['double_click', 'refresh_mid_flow']));
  });

  it('builds the right browser actions and respects eligibility', () => {
    const always = (
      type: 'double_click' | 'rapid_repeat' | 'back_forward' | 'tab_hopping' | 'offline_blip',
      repeat?: number,
    ) => planBehaviors([{ type, probability: 1, repeat }], click, createRng(1))[0]!;
    expect(always('double_click').actions).toEqual([
      { type: 'click', ref: 'e3', reason: '[double_click] persona behavior' },
    ]);
    expect(always('rapid_repeat', 4).actions).toHaveLength(3);
    expect(always('back_forward').actions.map((a) => a.type)).toEqual(['goBack', 'goForward']);
    expect(always('tab_hopping', 2).actions).toEqual([
      expect.objectContaining({ type: 'press', key: 'Tab' }),
      expect.objectContaining({ type: 'press', key: 'Tab' }),
    ]);
    expect(always('offline_blip')).toMatchObject({ kind: 'OFFLINE', offlineMs: 3000, actions: [] });

    const scroll = { type: 'scroll' as const, direction: 'down' as const, reason: 'x' };
    expect(planBehaviors([{ type: 'double_click', probability: 1 }], scroll, createRng(1))).toEqual(
      [],
    );
  });
});

describe('rng and profiles', () => {
  it('derives distinct, stable seeds', () => {
    expect(deriveSeed(1, 'a', 'bc')).toBe(deriveSeed(1, 'a', 'bc'));
    expect(deriveSeed(1, 'a', 'bc')).not.toBe(deriveSeed(1, 'ab', 'c'));
    const rng = createRng(3);
    const ints = Array.from({ length: 200 }, () => rng.int(1, 3));
    expect(new Set(ints)).toEqual(new Set([1, 2, 3]));
  });

  it('resolves device presets, custom devices and network profiles', () => {
    expect(resolveDevice('iphone-13')).toMatchObject({
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    expect(resolveDevice({ width: 375, height: 667, mobile: true })).toMatchObject({
      isMobile: true,
      hasTouch: true,
    });
    expect(resolveNetwork('none')).toBeNull();
    expect(resolveNetwork('slow-3g')!.latency).toBe(2000);
  });
});
