/**
 * Extracts a JSON value from model text. Handles bare JSON, ```json fences and
 * leading/trailing prose. Throws SyntaxError when no JSON object or array is found.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the lenient paths
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }

  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(close);
    if (end > start) return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new SyntaxError('No JSON found in model output');
}
