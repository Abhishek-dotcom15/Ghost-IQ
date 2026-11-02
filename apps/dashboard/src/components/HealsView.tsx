import { useCallback, useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import type { Project } from '../App';
import { decideHeal, fetchHeals, type HealView } from '../lib/analytics';

interface HealsViewProps {
  project: Project;
  socket: Socket;
}

const muted = { fontSize: '0.8rem', color: 'hsl(var(--text-muted))' } as const;
const mono = { fontFamily: 'var(--font-mono)', fontSize: '0.8rem' } as const;

const FILTERS = [
  { value: 'pending', label: 'Awaiting review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: '', label: 'All' },
];

/**
 * Review queue for locators healed during replay. Approved heals replace the recorded
 * locator in exported tests and later replays; rejected ones count as false heals.
 */
export default function HealsView({ project, socket }: HealsViewProps) {
  const [status, setStatus] = useState('pending');
  const [heals, setHeals] = useState<HealView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHeals(await fetchHeals(project.id, status));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [project.id, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onUpdate = (e: { projectId: string }) => {
      if (e.projectId === project.id) void load();
    };
    socket.on('heals-updated', onUpdate);
    return () => {
      socket.off('heals-updated', onUpdate);
    };
  }, [socket, project.id, load]);

  const decide = async (id: string, next: 'approved' | 'rejected') => {
    try {
      await decideHeal(id, next);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="glass-card" style={{ padding: '1rem' }}>
        <p style={{ fontSize: '0.9rem' }}>
          When a replay cannot find a recorded element, GhostIQ looks for a same-role element with a
          similar name, then asks the model (accepted only at 85% confidence or higher). A heal is
          never trusted until you approve it: approved locators go into exported tests and later
          replays. Page URLs and the end state are never healed.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={`btn ${status === f.value ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem' }}
            onClick={() => setStatus(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <div style={{ color: 'hsl(var(--danger))' }}>{error}</div>}
      {heals.length === 0 && (
        <div className="glass-card" style={{ ...muted, textAlign: 'center', padding: '2.5rem' }}>
          {status === 'pending' ? 'Nothing to review.' : 'No heals here.'}
        </div>
      )}

      {heals.map((h) => (
        <div
          key={h.id}
          className="glass-card"
          style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '1rem',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>
                Step {h.stepNumber} of {h.sourceName ?? h.sourceSessionId.slice(0, 8)}
              </div>
              <div style={muted}>
                {h.method === 'fuzzy' ? 'Similar name, same role' : 'Model suggestion'} · confidence{' '}
                {Math.round(h.confidence * 100)}% · {new Date(h.createdAt).toLocaleString()}
              </div>
            </div>
            {h.status === 'pending' ? (
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="btn btn-primary"
                  style={{ fontSize: '0.8rem' }}
                  onClick={() => decide(h.id, 'approved')}
                >
                  <Check size={14} /> Approve
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: '0.8rem' }}
                  onClick={() => decide(h.id, 'rejected')}
                >
                  <X size={14} /> Reject
                </button>
              </div>
            ) : (
              <span
                className={`badge ${h.status === 'approved' ? 'badge-success' : 'badge-danger'}`}
              >
                {h.status === 'approved' ? <Check size={12} /> : <X size={12} />} {h.status}
              </span>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: '0.75rem',
            }}
          >
            <Side label="Recorded" locator={h.oldLocator} screenshot={h.beforeScreenshot} />
            <Side label="Found in replay" locator={h.newLocator} screenshot={h.afterScreenshot} />
          </div>
          <div style={muted}>Why: {h.reason}</div>
        </div>
      ))}
    </div>
  );
}

function Side({
  label,
  locator,
  screenshot,
}: {
  label: string;
  locator: { role: string; name: string };
  screenshot: string | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <span style={muted}>{label}</span>
      <code className="code-block" style={{ ...mono, padding: '0.5rem 0.65rem' }}>
        getByRole({JSON.stringify(locator.role)}, {'{'} name: {JSON.stringify(locator.name)} {'}'})
      </code>
      {screenshot ? (
        <a href={screenshot} target="_blank" rel="noreferrer">
          <img
            src={screenshot}
            alt={`${label}: page with ${locator.role} "${locator.name}"`}
            style={{
              width: '100%',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-glass)',
            }}
          />
        </a>
      ) : (
        <span style={muted}>(no screenshot)</span>
      )}
    </div>
  );
}
