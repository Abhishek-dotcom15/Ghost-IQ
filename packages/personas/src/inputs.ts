import type { InputStrategy } from '@ghostiq/shared';
import { createRng, deriveSeed, type Rng } from './rng.js';

export const FIELD_KINDS = [
  'email',
  'password',
  'phone',
  'number',
  'url',
  'date',
  'name',
  'search',
  'postal',
  'card',
  'text',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Guesses what a field expects from its role and accessible name. */
export function inferFieldKind(field: { role: string; name: string }): FieldKind {
  const name = field.name.toLowerCase();
  if (field.role === 'searchbox' || /\bsearch\b|\bquery\b|find/.test(name)) return 'search';
  if (field.role === 'spinbutton') return 'number';
  if (/e-?mail/.test(name)) return 'email';
  if (/pass(word|code)?|\bpin\b/.test(name)) return 'password';
  if (/phone|mobile|\btel\b/.test(name)) return 'phone';
  if (/card number|credit|\bcvv\b|\bcvc\b/.test(name)) return 'card';
  if (/\b(zip|postal|post code|postcode)\b/.test(name)) return 'postal';
  if (/\burl\b|website|link/.test(name)) return 'url';
  if (/\bdate\b|birthday|\bdob\b/.test(name)) return 'date';
  if (/\b(age|quantity|qty|amount|price|count|number)\b/.test(name)) return 'number';
  if (/\bname\b|first|last|surname|full name/.test(name)) return 'name';
  return 'text';
}

const FIRST = ['Ava', 'Liam', 'Noor', 'Mateo', 'Priya', 'Kenji', 'Zara', 'Omar', 'Elena', 'Kwame'];
const LAST = [
  'Chen',
  'Okafor',
  'Silva',
  'Novak',
  'Haddad',
  'Iyer',
  'Kowalski',
  'Moreau',
  'Tanaka',
  'Mensah',
];
const WORDS = [
  'blue',
  'garden',
  'river',
  'socks',
  'laptop',
  'coffee',
  'orbit',
  'maple',
  'pixel',
  'harbor',
];

function valid(kind: FieldKind, rng: Rng): string {
  const first = rng.pick(FIRST);
  const last = rng.pick(LAST);
  switch (kind) {
    case 'email':
      return `${first.toLowerCase()}.${last.toLowerCase()}${rng.int(1, 99)}@example.test`;
    case 'password':
      return `Gh0st-${rng.pick(WORDS)}-${rng.int(1000, 9999)}!`;
    case 'phone':
      return `+1 555 ${rng.int(100, 999)} ${rng.int(1000, 9999)}`;
    case 'number':
      return String(rng.int(1, 99));
    case 'url':
      return `https://${rng.pick(WORDS)}.example.test`;
    case 'date':
      return `19${rng.int(70, 99)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
    case 'name':
      return `${first} ${last}`;
    case 'search':
      return rng.pick(WORDS);
    case 'postal':
      return String(rng.int(10000, 99999));
    case 'card':
      return '4242 4242 4242 4242'; // standard test card number
    case 'text':
      return `${rng.pick(WORDS)} ${rng.pick(WORDS)} ${rng.pick(WORDS)}`;
  }
}

function boundary(kind: FieldKind, rng: Rng): string {
  const generic = [' ', 'a', ' leading and trailing spaces ', 'x'.repeat(256), 'y'.repeat(1025)];
  const byKind: Partial<Record<FieldKind, string[]>> = {
    email: [
      'a@b',
      'no-at-sign.example.test',
      `${'l'.repeat(64)}@example.test`,
      'user@@example.test',
      '@example.test',
    ],
    password: ['1', 'p'.repeat(129), 'password', '        '],
    phone: ['0', '+', '1'.repeat(30), 'abc'],
    number: ['0', '-1', '2147483648', '1e309', '3.14159', 'NaN'],
    date: ['0000-00-00', '9999-12-31', '2026-02-30', 'yesterday'],
    postal: ['0', '1234567890123', 'ABCDE'],
    card: ['4242', '0000 0000 0000 0000', '4242 4242 4242 4241'],
    url: ['http://', 'ftp://example.test', 'example', `https://${'a'.repeat(300)}.test`],
  };
  return rng.pick([...(byKind[kind] ?? []), ...generic]);
}

/**
 * Probes for missing escaping and validation. They are inert strings: harmful only to an
 * app that already mishandles input, which is the defect being looked for.
 */
const NAUGHTY = [
  "' OR '1'='1",
  "Robert'); DROP TABLE students;--",
  '<script>alert("ghostiq")</script>',
  '"><img src=x onerror=alert(1)>',
  '{{7*7}}',
  '${7*7}',
  '../../../../etc/passwd',
  'null',
  'undefined',
  'true',
  '%00',
  '\\',
  'javascript:alert(1)',
  '0x7FFFFFFF',
  '-0',
];

const UNICODE = [
  'Zoë Ångström',
  '山田 太郎',
  'محمد العربي',
  'שלום עולם',
  '👻🔥💯',
  '👨‍👩‍👧‍👦 family',
  'é (e + combining acute)',
  'zero​width',
  'right-to-left ‮override',
  'Ω≈ç√∫˜µ≤≥÷',
  '𝓕𝓪𝓷𝓬𝔂',
  'Z̴̡̛a̷l̸g̶o̴',
];

function generate(kind: FieldKind, strategy: Exclude<InputStrategy, 'mixed'>, rng: Rng): string {
  switch (strategy) {
    case 'valid':
      return valid(kind, rng);
    case 'boundary':
      return boundary(kind, rng);
    case 'naughty_strings':
      return rng.pick(NAUGHTY);
    case 'unicode':
      return kind === 'email'
        ? `${rng.pick(['zoë', '山田', 'محمد'])}@example.test`
        : rng.pick(UNICODE);
    case 'empty':
      return '';
  }
}

const MIXED: ReadonlyArray<Exclude<InputStrategy, 'mixed'>> = [
  'valid',
  'valid',
  'boundary',
  'naughty_strings',
  'unicode',
  'empty',
];

/**
 * Seeded form values. Each value depends only on (seed, field identity, how many times that
 * field was filled before), so it is reproducible even if the planner visits fields in a
 * different order.
 */
export class InputGenerator {
  private readonly occurrences = new Map<string, number>();

  constructor(private readonly seed: number) {}

  value(
    field: { role: string; name: string },
    strategy: InputStrategy,
  ): { value: string; kind: FieldKind; strategy: InputStrategy } {
    const key = `${field.role}|${field.name}`;
    const occurrence = this.occurrences.get(key) ?? 0;
    this.occurrences.set(key, occurrence + 1);
    const rng = createRng(deriveSeed(this.seed, 'input', key, occurrence));
    const kind = inferFieldKind(field);
    const effective = strategy === 'mixed' ? rng.pick(MIXED) : strategy;
    return { value: generate(kind, effective, rng), kind, strategy: effective };
  }
}

/** Preview for the Persona Builder: sample values per field kind for a seed and strategy. */
export function sampleInputs(seed: number, strategy: InputStrategy, samplesPerKind = 2) {
  const generator = new InputGenerator(seed);
  const samples: Array<{ field: string; kind: FieldKind; strategy: InputStrategy; value: string }> =
    [];
  const fields: Array<{ role: string; name: string }> = [
    { role: 'textbox', name: 'Email address' },
    { role: 'textbox', name: 'Password' },
    { role: 'textbox', name: 'Full name' },
    { role: 'textbox', name: 'Phone number' },
    { role: 'spinbutton', name: 'Quantity' },
    { role: 'searchbox', name: 'Search' },
    { role: 'textbox', name: 'Comment' },
  ];
  for (const field of fields) {
    for (let i = 0; i < samplesPerKind; i++) {
      const generated = generator.value(field, strategy);
      samples.push({ field: field.name, ...generated });
    }
  }
  return samples;
}
