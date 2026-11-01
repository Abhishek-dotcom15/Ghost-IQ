/** Formats small LLM costs with enough precision to be meaningful. */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(2)}`;
}
