/** One element line from an AI-mode aria snapshot. */
export interface SnapshotElement {
  ref: string;
  role: string;
  /** Accessible name; empty when the element has none. */
  name: string;
  /** Snapshot attributes without the ref, e.g. ["level=2", "active"]. */
  attributes: string[];
}

// - button "Sign In" [ref=e12] [cursor=pointer]
// - textbox "Email address" [active] [ref=e9]:
// - textbox [ref=e14]
const LINE = /^\s*-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)/;

/** Parses every element that carries a ref. Lines without refs (text, props) are skipped. */
export function parseAriaSnapshot(snapshot: string): Map<string, SnapshotElement> {
  const elements = new Map<string, SnapshotElement>();
  for (const line of snapshot.split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, role, rawName, rawAttrs] = match;
    const attributes = [...(rawAttrs ?? '').matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!);
    const refAttr = attributes.find((a) => a.startsWith('ref='));
    if (!refAttr || !role) continue;
    const ref = refAttr.slice(4);
    elements.set(ref, {
      ref,
      role,
      name: (rawName ?? '').replace(/\\(.)/g, '$1'),
      attributes: attributes.filter((a) => a !== refAttr),
    });
  }
  return elements;
}

const NON_TARGETABLE_ROLES = new Set(['generic', 'none', 'presentation']);

/**
 * Playwright code that finds the element again without the snapshot ref.
 * Null for anonymous or structural elements, which need a better locator strategy (Phase 5).
 */
export function locatorCode(element: Pick<SnapshotElement, 'role' | 'name'>): string | null {
  if (!element.name || NON_TARGETABLE_ROLES.has(element.role)) return null;
  return `page.getByRole(${JSON.stringify(element.role)}, { name: ${JSON.stringify(element.name)} })`;
}

/** Normalizes "http://localhost:3000/x" or "localhost:3000" to an origin, or null. */
export function toOrigin(value: string): string | null {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).origin;
  } catch {
    return null;
  }
}

/** True when the URL is http(s) and its origin is in the allowlist. */
export function isAllowedUrl(url: string, allowedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return allowedOrigins.some((o) => toOrigin(o) === parsed.origin);
}

/**
 * Controls whose accessible name suggests an irreversible or costly action. Clicking them
 * needs `allowDestructive`; otherwise the step is skipped and recorded.
 */
const DESTRUCTIVE =
  /\b(delete|remove|destroy|erase|purge|drop|pay|pay now|payment|purchase|buy now|place order|confirm order|cancel (my )?(subscription|plan|account)|unsubscribe|deactivate|close account|terminate|transfer funds?|wipe|reset all)\b/i;

export function isDestructiveName(name: string): boolean {
  return DESTRUCTIVE.test(name);
}

/** Field names whose typed values must not be stored or shown. */
const SECRET_FIELD =
  /pass(word|code)?|secret|token|api[\s_-]?key|\botp\b|\bpin\b|\bcvv\b|\bcvc\b|card number/i;

export function isSecretField(name: string): boolean {
  return SECRET_FIELD.test(name);
}

export const MASK = '••••••';
