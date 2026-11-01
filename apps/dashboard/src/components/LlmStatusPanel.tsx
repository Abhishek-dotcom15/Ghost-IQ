import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatUsd } from '../lib/format';

interface Usage {
  calls: number;
  failedCalls: number;
  fallbackCalls: number;
  cacheHits: number;
  unpricedCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

interface LlmStatus {
  mode: 'live' | 'demo';
  demoReason: string | null;
  provider: string;
  model: string;
  fallbacks: Array<{ provider: string; model: string }>;
  health: {
    ok: boolean;
    latencyMs: number;
    errorKind?: string;
    message: string;
    hint?: string;
  } | null;
  usage: { allTime: Usage; last24h: Usage };
}

const muted = { fontSize: '0.8rem', color: 'hsl(var(--text-muted))' } as const;
const mono = { fontFamily: 'var(--font-mono)', fontSize: '0.8rem' } as const;

/** Read-only view of the server's LLM configuration. Keys live in the server environment, never in the browser. */
export default function LlmStatusPanel() {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/llm/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      className="glass-card"
      style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '720px' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3
          style={{
            fontFamily: 'var(--font-title)',
            fontSize: '1.25rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <Sparkles size={18} style={{ color: 'hsl(var(--accent-purple))' }} /> AI model
        </h3>
        <button className="btn btn-secondary" onClick={() => void load()}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <p style={{ color: 'hsl(var(--accent-red, 0 80% 60%))' }}>Could not load status: {error}</p>
      )}
      {!status && !error && <p style={muted}>Loading…</p>}

      {status && (
        <>
          {status.mode === 'demo' ? (
            <Banner tone="warn" title="Demo mode: scripted, no AI">
              {status.demoReason} Runs follow a fixed script for the demo app; steps are labelled
              [demo].
            </Banner>
          ) : status.health && !status.health.ok ? (
            <Banner tone="warn" title={`Model check failed (${status.health.errorKind})`}>
              {status.health.message}
              {status.health.hint && (
                <div style={{ marginTop: '0.4rem' }}>Fix: {status.health.hint}</div>
              )}
            </Banner>
          ) : status.health?.ok ? (
            <Banner tone="ok" title="Model reachable">
              Returned valid structured output in {status.health.latencyMs} ms.
            </Banner>
          ) : (
            <p style={muted}>Health check still running…</p>
          )}

          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              gap: '0.5rem 1.25rem',
              margin: 0,
            }}
          >
            <dt style={muted}>Provider</dt>
            <dd style={{ ...mono, margin: 0 }}>{status.provider}</dd>
            <dt style={muted}>Model</dt>
            <dd style={{ ...mono, margin: 0 }}>{status.model}</dd>
            <dt style={muted}>Fallbacks</dt>
            <dd style={{ ...mono, margin: 0 }}>
              {status.fallbacks.length
                ? status.fallbacks.map((f) => `${f.provider}/${f.model}`).join(' → ')
                : 'none'}
            </dd>
          </dl>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '0.75rem',
            }}
          >
            <Stat label="Cost, last 24 h" value={formatUsd(status.usage.last24h.costUsd)} />
            <Stat label="Cost, all time" value={formatUsd(status.usage.allTime.costUsd)} />
            <Stat label="Calls, last 24 h" value={String(status.usage.last24h.calls)} />
            <Stat
              label="Failed / fallback"
              value={`${status.usage.last24h.failedCalls} / ${status.usage.last24h.fallbackCalls}`}
            />
            <Stat
              label="Tokens in / out (24 h)"
              value={`${status.usage.last24h.tokensIn.toLocaleString()} / ${status.usage.last24h.tokensOut.toLocaleString()}`}
            />
          </div>
          {status.usage.allTime.unpricedCalls > 0 && (
            <p style={muted}>
              {status.usage.allTime.unpricedCalls} call(s) used a model without a known price and
              are not included in the cost. Set GHOSTIQ_LLM_PRICE_INPUT and GHOSTIQ_LLM_PRICE_OUTPUT
              to include them.
            </p>
          )}

          <p style={muted}>
            Configure the model on the server with environment variables (
            <code style={mono}>GHOSTIQ_LLM_PROVIDER</code>,{' '}
            <code style={mono}>GHOSTIQ_LLM_MODEL</code>,{' '}
            <code style={mono}>GHOSTIQ_LLM_API_KEY</code>,{' '}
            <code style={mono}>GHOSTIQ_LLM_FALLBACK</code>) and restart it. See{' '}
            <code style={mono}>apps/server/.env.example</code>.
          </p>
        </>
      )}
    </div>
  );
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: 'ok' | 'warn';
  title: string;
  children: ReactNode;
}) {
  const color =
    tone === 'ok'
      ? 'hsl(var(--accent-green, 145 60% 45%))'
      : 'hsl(var(--accent-amber, 38 92% 55%))';
  return (
    <div
      style={{
        border: `1px solid ${color}`,
        borderRadius: 'var(--radius-md)',
        padding: '0.85rem 1rem',
        display: 'flex',
        gap: '0.75rem',
      }}
    >
      {tone === 'ok' ? (
        <CheckCircle2 size={18} style={{ color, flexShrink: 0 }} />
      ) : (
        <AlertTriangle size={18} style={{ color, flexShrink: 0 }} />
      )}
      <div style={{ fontSize: '0.85rem' }}>
        <strong>{title}</strong>
        <div style={{ color: 'hsl(var(--text-muted))', marginTop: '0.25rem' }}>{children}</div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--border-glass)',
        borderRadius: 'var(--radius-sm)',
        padding: '0.75rem',
      }}
    >
      <div style={muted}>{label}</div>
      <div
        style={{
          fontFamily: 'var(--font-title)',
          fontSize: '1.1rem',
          fontWeight: 600,
          marginTop: '0.2rem',
        }}
      >
        {value}
      </div>
    </div>
  );
}
