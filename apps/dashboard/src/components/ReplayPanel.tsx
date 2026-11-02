import { useCallback, useEffect, useState } from 'react';
import { Download, Repeat } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { fetchReplayStats, startReplays, type ReplayStats } from '../lib/analytics';

interface ReplayPanelProps {
  session: {
    id: string;
    status: string;
    endReason?: string | null;
    mode?: string;
    replayOfId?: string | null;
  };
  socket: Socket;
  onOpenSession: (id: string) => void;
}

const muted = { fontSize: '0.8rem', color: 'hsl(var(--text-muted))' } as const;
const small = { fontSize: '0.7rem', padding: '0.2rem 0.6rem', textDecoration: 'none' } as const;

/**
 * "Explore once, replay forever": export a passing run as a Playwright test, or replay it
 * N times without the planner model to measure flakiness and catch regressions.
 */
export default function ReplayPanel({ session, socket, onOpenSession }: ReplayPanelProps) {
  const [stats, setStats] = useState<ReplayStats | null>(null);
  const [runs, setRuns] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isReplay = session.mode === 'replay';
  const replayable = !isReplay && session.endReason === 'goal_met';

  const load = useCallback(async () => {
    if (!replayable) return;
    try {
      setStats(await fetchReplayStats(session.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [session.id, replayable]);

  useEffect(() => {
    setStats(null);
    setError(null);
    void load();
  }, [load]);

  // Refresh while replays of this run progress.
  useEffect(() => {
    if (!stats) return;
    const ids = stats.replays
      .filter((r) => r.status === 'PENDING' || r.status === 'RUNNING')
      .map((r) => r.id);
    const handlers = ids.map((id) => {
      const event = `session-update:${id}`;
      const handler = (msg: { type: string }) => {
        if (msg.type === 'session-completed') void load();
      };
      socket.on(event, handler);
      return () => socket.off(event, handler);
    });
    return () => handlers.forEach((off) => off());
  }, [socket, stats, load]);

  if (isReplay) {
    return (
      <div
        className="glass-card"
        style={{ padding: '0.75rem 1rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}
      >
        <span className="badge badge-info">
          <Repeat size={12} /> REPLAY
        </span>
        <span style={muted}>
          Deterministic re-run of a recorded run: same actions and values, no planner model.
        </span>
        {session.replayOfId && (
          <button
            className="btn btn-secondary"
            style={small}
            onClick={() => onOpenSession(session.replayOfId!)}
          >
            Open recorded run
          </button>
        )}
      </div>
    );
  }
  if (!replayable) return null;

  const replay = async () => {
    setBusy(true);
    setError(null);
    try {
      await startReplays(session.id, runs);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="glass-card"
      style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
    >
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1rem', marginRight: 'auto' }}>
          Replay &amp; export
        </h3>
        <a
          href={`/api/sessions/${session.id}/export/spec`}
          className="btn btn-secondary"
          style={small}
        >
          <Download size={12} /> Playwright test (.spec.ts)
        </a>
        <label style={{ ...muted, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          Runs
          <select
            value={runs}
            onChange={(e) => setRuns(Number(e.target.value))}
            style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }}
          >
            {[1, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" style={small} onClick={replay} disabled={busy}>
          <Repeat size={12} /> Replay
        </button>
      </div>
      <p style={muted}>
        Replays repeat this run's actions without the planner model, one after another. Renamed
        controls are healed (and queued for review); a different page or end state fails the replay.
      </p>
      {error && <div style={{ color: 'hsl(var(--danger))', fontSize: '0.8rem' }}>{error}</div>}
      {stats && stats.replays.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: '1.25rem', fontSize: '0.85rem' }}>
            <span>
              <strong>{stats.passed}</strong> <span style={muted}>passed</span>
            </span>
            <span>
              <strong>{stats.failed}</strong> <span style={muted}>failed</span>
            </span>
            <span>
              <strong>{Math.round(stats.flakinessScore)}%</strong> <span style={muted}>flaky</span>
            </span>
          </div>
          <ul
            style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}
          >
            {stats.replays.slice(0, 10).map((r) => (
              <li
                key={r.id}
                style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', fontSize: '0.8rem' }}
              >
                <span
                  className={`badge ${r.status === 'PASSED' ? 'badge-success' : r.status === 'FAILED' ? 'badge-danger' : 'badge-warning'}`}
                  style={{ fontSize: '0.65rem' }}
                >
                  {r.status}
                </span>
                <button
                  onClick={() => onOpenSession(r.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'hsl(var(--info))',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                  }}
                >
                  {new Date(r.startedAt).toLocaleString()}
                </button>
                {r.healedSteps.length > 0 && (
                  <span className="badge badge-warning" style={{ fontSize: '0.65rem' }}>
                    healed step {r.healedSteps.join(', ')}
                  </span>
                )}
                {r.status === 'FAILED' && <span style={muted}>{r.summary}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
