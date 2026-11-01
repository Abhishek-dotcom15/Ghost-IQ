import {
  loadBuiltinPersonas,
  loadPersonaDir,
  parsePersona,
  resolveDevice,
  sampleInputs,
  type PersonaError,
} from '@ghostiq/personas';
import type { PersonaSpec } from '@ghostiq/shared';
import type { PrismaClient } from '../db.js';

export type PersonaSource = 'builtin' | 'file' | 'custom';

export interface PersonaRecord {
  id: string;
  name: string;
  description: string;
  source: PersonaSource;
  /** Only custom personas can be edited or deleted through the API. */
  editable: boolean;
  version: number;
  yaml: string;
  spec: PersonaSpec;
}

export class PersonaValidationError extends Error {
  constructor(readonly errors: PersonaError[]) {
    super('Invalid persona');
  }
}

export class PersonaConflictError extends Error {}

/**
 * All personas available to runs: built-in (shipped YAML), file-based (GHOSTIQ_PERSONAS_DIR,
 * read at boot) and custom (created in the dashboard, stored in the database).
 * Built-in and file ids are reserved; custom personas cannot shadow them.
 */
export class PersonaRegistry {
  private readonly fixed = new Map<string, PersonaRecord>();

  constructor(
    private readonly prisma: PrismaClient,
    personasDir?: string,
  ) {
    for (const { persona, yaml } of loadBuiltinPersonas()) {
      this.fixed.set(persona.id, toRecord(persona, yaml, 'builtin', 1));
    }
    if (personasDir) {
      for (const { persona, yaml, source } of loadPersonaDir(personasDir)) {
        if (this.fixed.has(persona.id)) {
          throw new Error(
            `Persona "${persona.id}" in ${source} clashes with a built-in persona id.`,
          );
        }
        this.fixed.set(persona.id, toRecord(persona, yaml, 'file', 1));
      }
    }
  }

  async list(): Promise<PersonaRecord[]> {
    const custom = await this.prisma.persona.findMany({ orderBy: { createdAt: 'asc' } });
    return [
      ...this.fixed.values(),
      ...custom.map(fromRow).filter((r): r is PersonaRecord => r !== null),
    ];
  }

  async get(id: string): Promise<PersonaRecord | null> {
    const fixed = this.fixed.get(id);
    if (fixed) return fixed;
    const row = await this.prisma.persona.findUnique({ where: { id } });
    return row ? fromRow(row) : null;
  }

  /** Validates YAML and returns the parsed persona plus a preview of what it will do. */
  validate(yaml: string) {
    const result = parsePersona(yaml);
    if (!result.ok) return { ok: false as const, errors: result.errors };
    return { ok: true as const, persona: result.persona, preview: preview(result.persona) };
  }

  async create(yaml: string): Promise<PersonaRecord> {
    const persona = this.parseOrThrow(yaml);
    if (
      this.fixed.has(persona.id) ||
      (await this.prisma.persona.findUnique({ where: { id: persona.id } }))
    ) {
      throw new PersonaConflictError(`A persona with id "${persona.id}" already exists.`);
    }
    const row = await this.prisma.persona.create({
      data: { id: persona.id, name: persona.name, description: persona.description, yaml },
    });
    return fromRow(row)!;
  }

  async update(id: string, yaml: string): Promise<PersonaRecord | null> {
    if (this.fixed.has(id))
      throw new PersonaConflictError(`"${id}" is not a custom persona and cannot be edited.`);
    const existing = await this.prisma.persona.findUnique({ where: { id } });
    if (!existing) return null;
    const persona = this.parseOrThrow(yaml);
    if (persona.id !== id)
      throw new PersonaConflictError('The id in the YAML must match the persona being edited.');
    const row = await this.prisma.persona.update({
      where: { id },
      data: {
        name: persona.name,
        description: persona.description,
        yaml,
        version: existing.version + 1,
      },
    });
    return fromRow(row);
  }

  async delete(id: string): Promise<boolean> {
    if (this.fixed.has(id))
      throw new PersonaConflictError(`"${id}" is not a custom persona and cannot be deleted.`);
    const deleted = await this.prisma.persona.deleteMany({ where: { id } });
    return deleted.count > 0;
  }

  private parseOrThrow(yaml: string): PersonaSpec {
    const result = parsePersona(yaml);
    if (!result.ok) throw new PersonaValidationError(result.errors);
    return result.persona;
  }
}

/** What the Persona Builder shows before saving: sample inputs and effective settings. */
export function preview(persona: PersonaSpec) {
  const device = resolveDevice(persona.device);
  return {
    device: device.label,
    viewport: device.viewport,
    network: persona.network,
    pacing: persona.pacing,
    behaviors: persona.behaviors.map((b) => `${b.type} (${Math.round(b.probability * 100)}%)`),
    allowedActions: persona.allowed_actions ?? 'all',
    destructiveActions:
      persona.risk_tolerance === 'safe' ? 'never' : 'only when the run allows them',
    requiresConsent: persona.requires_consent,
    sampleInputs: sampleInputs(persona.seed, persona.input_strategy, 1),
  };
}

function toRecord(
  spec: PersonaSpec,
  yaml: string,
  source: PersonaSource,
  version: number,
): PersonaRecord {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    source,
    editable: source === 'custom',
    version,
    yaml,
    spec,
  };
}

function fromRow(row: { yaml: string; version: number }): PersonaRecord | null {
  // Rows were validated on save; a schema change could invalidate old rows, so re-check.
  const result = parsePersona(row.yaml);
  return result.ok ? toRecord(result.persona, row.yaml, 'custom', row.version) : null;
}
