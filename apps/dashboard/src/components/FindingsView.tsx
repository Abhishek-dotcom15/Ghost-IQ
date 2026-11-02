import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Download, ExternalLink } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import type { Project } from '../App';
import {
  SEVERITY_ORDER,
  SEVERITY_STYLE,
  TYPE_LABELS,
  fetchFindings,
  triageFinding,
  type FindingStatus,
  type FindingView,
  type FindingsSummary,
} from '../lib/findings';

interface FindingsViewProps {
  project: Project;
  socket: Socket;
}

const muted = { fontSize: '0.8rem', color: 'hsl(var(--text-muted))' } as const;
const mono = { fontFamily: 'var(--font-mono)', fontSize: '0.8rem' } as const;

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'open,confirmed', label: 'Active (open + confirmed)' },
  { value: 'open', label: 'Open' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'dismissed', label: 'Dismissed (false positives)' },
  { value: 'fixed', label: 'Fixed' },
  { value: '', label: 'All' },
];

/** Deduplicated, severity-ranked findings with evidence, repro steps and triage. */
export default function FindingsView({ project, socket }: FindingsViewProps) {
  const [findings, setFindings] = useState<FindingView[]>([]);
  const [summary, setSummary] = useState<FindingsSummary | null>(null);
  const [status, setStatus] = useState('open,confirmed');
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');
  const [persona, setPersona] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchFindings(project.id, { status, severity, type, persona });
      setFindings(data.findings);
      setSummary(data.summary);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [project.id, status, severity, type, persona]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: new findings appear while runs are in progress.
  useEffect(() => {
    const onUpdate = (event: { projectId: string }) => {
      if (event.projectId === project.id) void load();
    };
    socket.on('findings-updated', onUpdate);
    return () => {
      socket.off('findings-updated', onUpdate);
    };
  }, [socket, project.id, load]);

  const triage = async (id: string, next: FindingStatus) => {
    try {
      await triageFinding(id, next);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Severity counts + reports */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'stretch' }}>
        {SEVERITY_ORDER.map((s) => (
          <button
            key={s}
            className="glass-card"
            onClick={() => setSeverity(severity === s ? '' : s)}
            style={{
              padding: '0.75rem 1rem',
              minWidth: '110px',
              cursor: 'pointer',
              borderColor: severity === s ? SEVERITY_STYLE[s].color : undefined,
              textAlign: 'left',
              // <button> does not inherit the page's text colour.
              color: 'hsl(var(--text-primary))',
              font: 'inherit',
            }}
            title={`Show only ${s}`}
          >
            <div style={{ ...muted, color: SEVERITY_STYLE[s].color }}>
              {SEVERITY_STYLE[s].label}
            </div>
            <div style={{ fontFamily: 'var(--font-title)', fontSize: '1.5rem', fontWeight: 700 }}>
              {summary?.bySeverity[s] ?? 0}
            </div>
          </button>
        ))}
        <div
          className="glass-card"
          style={{
            padding: '0.75rem 1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.35rem',
            marginLeft: 'auto',
          }}
        >
          <span style={muted}>Project report (active findings)</span>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {(['html', 'json', 'junit', 'sarif'] as const).map((format) => (
              <a
                key={format}
                href={`/api/projects/${project.id}/report?format=${format}`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary"
                style={{ fontSize: '0.7rem', padding: '0.2rem 0.6rem', textDecoration: 'none' }}
              >
                <Download size={12} /> {format.toUpperCase()}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Per-persona yield */}
      {summary && summary.byPersona.length > 0 && (
        <div className="glass-card" style={{ padding: '1rem' }}>
          <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1rem', marginBottom: '0.5rem' }}>
            Findings by persona
          </h3>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {summary.byPersona.map((p) => (
              <button
                key={p.persona}
                onClick={() => setPersona(persona === p.persona ? '' : p.persona)}
                className={`btn ${persona === p.persona ? 'btn-primary' : 'btn-secondary'}`}
                title="Click to show only this persona's findings"
              >
                {p.persona}: {p.total}
                {p.unique > 0 && (
                  <span style={{ color: 'hsl(var(--success))' }}>
                    {' '}
                    · {p.unique} only they found
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status filter"
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type filter">
          <option value="">All types</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
              {summary?.byType[value] ? ` (${summary.byType[value]})` : ''}
            </option>
          ))}
        </select>
        {(severity || persona || type) && (
          <button
            className="btn btn-secondary"
            onClick={() => {
              setSeverity('');
              setPersona('');
              setType('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {error && <p style={{ color: 'hsl(var(--danger))' }}>{error}</p>}
      {!error && findings.length === 0 && (
        <div className="glass-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={muted}>No findings match. Run a persona against your app to find some.</p>
        </div>
      )}

      {/* Findings */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {findings.map((f) => {
          const open = expanded === f.id;
          return (
            <div
              key={f.id}
              className="glass-card"
              style={{
                padding: 0,
                overflow: 'hidden',
                borderLeft: `3px solid ${SEVERITY_STYLE[f.severity].color}`,
              }}
            >
              <button
                onClick={() => setExpanded(open ? null : f.id)}
                style={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  width: '100%',
                  padding: '0.85rem 1rem',
                  display: 'flex',
                  gap: '0.75rem',
                  alignItems: 'center',
                  cursor: 'pointer',
                }}
                aria-expanded={open}
              >
                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <span
                  style={{
                    color: SEVERITY_STYLE[f.severity].color,
                    fontWeight: 700,
                    fontSize: '0.7rem',
                    textTransform: 'uppercase',
                    minWidth: '4.5rem',
                  }}
                >
                  {f.severity}
                </span>
                <span style={{ flex: 1, fontSize: '0.9rem' }}>
                  {f.title}
                  {f.confidence === 'suspected' && (
                    <span
                      className="badge badge-warning"
                      style={{ fontSize: '0.6rem', marginLeft: '0.5rem' }}
                      title="Heuristic oracle: needs a human look"
                    >
                      suspected
                    </span>
                  )}
                  {f.status !== 'open' && (
                    <span className="badge" style={{ fontSize: '0.6rem', marginLeft: '0.5rem' }}>
                      {f.status}
                    </span>
                  )}
                </span>
                <span style={muted}>{TYPE_LABELS[f.type] ?? f.type}</span>
                <span style={{ ...muted, minWidth: '4rem', textAlign: 'right' }} title="Times seen">
                  ×{f.recurrences}
                </span>
              </button>

              {open && (
                <div
                  style={{
                    padding: '0 1rem 1rem 2.75rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                    fontSize: '0.85rem',
                  }}
                >
                  <p>{f.message}</p>
                  <div style={muted}>
                    Route <code style={mono}>{f.route}</code>
                    {f.rule && (
                      <>
                        {' '}
                        · rule <code style={mono}>{f.rule}</code>
                      </>
                    )}{' '}
                    · found by {f.personas.join(', ')} · first{' '}
                    {new Date(f.firstSeenAt).toLocaleString()} · last{' '}
                    {new Date(f.lastSeenAt).toLocaleString()}
                  </div>
                  {f.triageNote && (
                    <div style={{ ...muted, color: 'hsl(var(--warning))' }}>{f.triageNote}</div>
                  )}
                  {f.evidence.detail && (
                    <pre
                      style={{
                        ...mono,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        background: 'rgba(0,0,0,0.25)',
                        padding: '0.6rem',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    >
                      {f.evidence.detail}
                    </pre>
                  )}
                  {f.evidence.request && (
                    <div style={mono}>
                      {f.evidence.request.method ?? 'GET'} {f.evidence.request.url}
                      {f.evidence.request.status !== undefined && ` → ${f.evidence.request.status}`}
                    </div>
                  )}
                  {(f.evidence.baselineImage || f.evidence.screenshot) && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: '0.75rem',
                      }}
                    >
                      {f.evidence.baselineImage && (
                        <Figure src={f.evidence.baselineImage} caption="Baseline" />
                      )}
                      {f.evidence.screenshot && (
                        <Figure
                          src={f.evidence.screenshot}
                          caption={`Step ${f.evidence.stepNumber ?? ''}`}
                        />
                      )}
                      {f.evidence.diffImage && (
                        <Figure src={f.evidence.diffImage} caption="Differences" />
                      )}
                    </div>
                  )}
                  {f.repro.length > 0 && (
                    <div>
                      <strong>Steps to reproduce</strong>
                      <ol style={{ margin: '0.35rem 0 0', paddingLeft: '1.25rem' }}>
                        {f.repro.map((step, i) => (
                          <li key={i}>{step.replace(/^\d+\.\s*/, '')}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                  <div
                    style={{
                      display: 'flex',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    {f.status !== 'confirmed' && (
                      <button
                        className="btn btn-primary"
                        onClick={() => void triage(f.id, 'confirmed')}
                      >
                        Confirm
                      </button>
                    )}
                    {f.status !== 'dismissed' && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => void triage(f.id, 'dismissed')}
                        title="False positive: it will stay dismissed if seen again"
                      >
                        Dismiss
                      </button>
                    )}
                    {f.status !== 'fixed' && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => void triage(f.id, 'fixed')}
                        title="It reopens automatically if seen again"
                      >
                        Mark fixed
                      </button>
                    )}
                    {f.status !== 'open' && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => void triage(f.id, 'open')}
                      >
                        Reopen
                      </button>
                    )}
                    <a
                      href={`/api/sessions/${f.evidence.sessionId}/report?format=html`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ ...muted, marginLeft: 'auto' }}
                    >
                      Run report <ExternalLink size={12} />
                    </a>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Figure({ src, caption }: { src: string; caption: string }) {
  return (
    <figure style={{ margin: 0 }}>
      <img
        src={src}
        alt={caption}
        style={{
          width: '100%',
          border: '1px solid var(--border-glass)',
          borderRadius: 'var(--radius-sm)',
        }}
      />
      <figcaption style={muted}>{caption}</figcaption>
    </figure>
  );
}
