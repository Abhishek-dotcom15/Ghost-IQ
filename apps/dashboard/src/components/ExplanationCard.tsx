import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { Explanation } from '@ghostiq/shared/explain';

const TONE = {
  success: { color: 'hsl(var(--success))', bg: 'rgba(17, 185, 129, 0.08)', Icon: CheckCircle2 },
  info: { color: 'hsl(var(--info))', bg: 'rgba(14, 165, 233, 0.08)', Icon: Info },
  warning: { color: 'hsl(var(--warning))', bg: 'rgba(245, 158, 11, 0.08)', Icon: AlertTriangle },
  error: { color: 'hsl(var(--danger))', bg: 'rgba(244, 63, 94, 0.08)', Icon: XCircle },
} as const;

interface ExplanationCardProps {
  explanation: Explanation;
  /** The raw code or error text, shown small underneath for reference. */
  technical?: string | null;
  compact?: boolean;
}

/** "What happened, why, and what to do" for a run's end or a step's error. */
export default function ExplanationCard({ explanation, technical, compact }: ExplanationCardProps) {
  const tone = TONE[explanation.tone];
  return (
    <div
      role={explanation.tone === 'error' ? 'alert' : 'status'}
      style={{
        background: tone.bg,
        border: `1px solid ${tone.color}`,
        borderRadius: 'var(--radius-sm)',
        padding: compact ? '0.6rem 0.75rem' : '0.85rem 1rem',
        display: 'flex',
        gap: '0.6rem',
        alignItems: 'flex-start',
        fontSize: '0.85rem',
        lineHeight: 1.45,
      }}
    >
      <tone.Icon size={16} style={{ color: tone.color, flexShrink: 0, marginTop: 2 }} aria-hidden />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 }}>
        <strong style={{ color: tone.color }}>{explanation.title}</strong>
        <span style={{ color: 'hsl(var(--text-primary))' }}>{explanation.detail}</span>
        {explanation.fix && (
          <span style={{ color: 'hsl(var(--text-muted))' }}>
            <strong style={{ color: 'hsl(var(--text-primary))' }}>What to do: </strong>
            {explanation.fix}
          </span>
        )}
        {technical && (
          <details style={{ marginTop: '0.2rem' }}>
            <summary
              style={{ cursor: 'pointer', fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}
            >
              Technical detail
            </summary>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.75rem',
                color: 'hsl(var(--text-muted))',
                marginTop: '0.3rem',
              }}
            >
              {technical}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
