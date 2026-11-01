/** Persona as returned by GET /api/personas. */
export interface PersonaView {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'file' | 'custom';
  editable: boolean;
  version: number;
  yaml: string;
  spec: {
    id: string;
    name: string;
    description: string;
    goals: string[];
    input_strategy: string;
    requires_consent: boolean;
    seed: number;
    device: unknown;
    network: string;
    behaviors: Array<{ type: string; probability: number }>;
  };
}

export interface PersonaError {
  line: number | null;
  column: number | null;
  path: string;
  message: string;
}

export interface PersonaPreview {
  device: string;
  viewport: { width: number; height: number };
  network: string;
  pacing: { min_ms: number; max_ms: number };
  behaviors: string[];
  allowedActions: string[] | 'all';
  destructiveActions: string;
  requiresConsent: boolean;
  sampleInputs: Array<{ field: string; kind: string; strategy: string; value: string }>;
}

export type ValidationResult =
  | { ok: true; persona: PersonaView['spec']; preview: PersonaPreview }
  | { ok: false; errors: PersonaError[] };

export async function fetchPersonas(): Promise<PersonaView[]> {
  const res = await fetch('/api/personas');
  if (!res.ok) throw new Error(`Failed to load personas (HTTP ${res.status})`);
  return res.json();
}

export async function validatePersona(yaml: string): Promise<ValidationResult> {
  const res = await fetch('/api/personas/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml }),
  });
  return res.json();
}

/** Replaces the top-level id (and name) so a copy of a built-in can be saved as custom. */
export function duplicateYaml(yaml: string, id: string): string {
  return yaml
    .replace(/^id:\s*.*$/m, `id: ${id}-copy`)
    .replace(/^name:\s*(.*)$/m, (_m, name: string) => `name: ${name.trim()} (copy)`);
}

export const NEW_PERSONA_TEMPLATE = `# Describe how this user behaves. Fields: see the built-in personas for examples.
id: my-persona
name: My Persona
description: Who this user is and what they care about.
traits: >-
  How they move through the app, what they notice, what they get wrong.
goals:
  - Sign in and reach the main page.
pacing: { min_ms: 300, max_ms: 900 }
input_strategy: valid # valid | boundary | naughty_strings | unicode | empty | mixed
behaviors: []
  # - { type: double_click, probability: 0.2 }
device: laptop # desktop | laptop | tablet | iphone-13 | pixel-7
network: none # none | fast-3g | slow-3g
risk_tolerance: normal # safe | normal | aggressive
seed: 42
`;
