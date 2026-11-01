import { PersonaSpec } from '@ghostiq/shared';
import { isMap, isScalar, LineCounter, parseDocument, type Document } from 'yaml';

export interface PersonaError {
  /** 1-based line in the source, when it can be located. */
  line: number | null;
  column: number | null;
  /** Dotted path of the offending field, e.g. "behaviors.0.probability". */
  path: string;
  message: string;
}

export type ParseResult =
  { ok: true; persona: PersonaSpec } | { ok: false; errors: PersonaError[] };

/**
 * Parses and validates a persona written in YAML (or JSON, which is valid YAML).
 * Every error carries the line it refers to, so the Persona Builder can point at it.
 */
export function parsePersona(source: string): ParseResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: false, uniqueKeys: true });

  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const pos = lineCounter.linePos(e.pos[0]);
        return { line: pos.line, column: pos.col, path: '', message: e.message.split('\n')[0]! };
      }),
    };
  }

  const data: unknown = doc.toJS();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      errors: [
        {
          line: 1,
          column: 1,
          path: '',
          message: 'A persona must be a mapping of fields (id, name, description, ...).',
        },
      ],
    };
  }

  const result = PersonaSpec.safeParse(data);
  if (result.success) return { ok: true, persona: result.data };

  const errors: PersonaError[] = [];
  for (const issue of result.error.issues) {
    const path = issue.path.filter((p): p is string | number => typeof p !== 'symbol');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const position = keyPosition(doc, path, key, lineCounter);
        errors.push({
          ...position,
          path: [...path, key].join('.'),
          message: `Unknown field "${key}" (check the spelling).`,
        });
      }
      continue;
    }
    errors.push({
      ...valuePosition(doc, path, lineCounter),
      path: path.join('.'),
      message: issue.message,
    });
  }
  errors.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
  return { ok: false, errors };
}

/** Position of the node at `path`, or of its closest existing ancestor (for missing fields). */
function valuePosition(doc: Document, path: Array<string | number>, lc: LineCounter) {
  for (let depth = path.length; depth >= 0; depth--) {
    const node = doc.getIn(path.slice(0, depth), true);
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    if (range) {
      const pos = lc.linePos(range[0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return { line: null, column: null };
}

function keyPosition(doc: Document, path: Array<string | number>, key: string, lc: LineCounter) {
  const parent = path.length === 0 ? doc.contents : doc.getIn(path, true);
  if (isMap(parent)) {
    for (const pair of parent.items) {
      if (isScalar(pair.key) && pair.key.value === key && pair.key.range) {
        const pos = lc.linePos(pair.key.range[0]);
        return { line: pos.line, column: pos.col };
      }
    }
  }
  return valuePosition(doc, path, lc);
}

/** Formats errors for logs and CLI output: "line 7: behaviors.0.probability: ...". */
export function formatPersonaErrors(errors: PersonaError[], source = 'persona'): string {
  return errors
    .map(
      (e) => `${source}${e.line ? `:${e.line}` : ''}: ${e.path ? `${e.path}: ` : ''}${e.message}`,
    )
    .join('\n');
}
