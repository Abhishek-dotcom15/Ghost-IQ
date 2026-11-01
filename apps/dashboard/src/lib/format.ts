/** Formats small LLM costs with enough precision to be meaningful. */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(2)}`;
}

export interface StepIssueView {
  kind: string;
  message: string;
}

/** Step issues are stored as JSON; tolerate missing or malformed values from older runs. */
export function parseIssues(json: string | null | undefined): StepIssueView[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter(
          (i): i is StepIssueView => typeof i?.kind === 'string' && typeof i?.message === 'string',
        )
      : [];
  } catch {
    return [];
  }
}
