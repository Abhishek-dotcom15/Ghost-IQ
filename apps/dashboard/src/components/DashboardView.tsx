import React, { useEffect, useState } from 'react';
import type { Project } from '../App';
import {
  PlayCircle,
  ShieldAlert,
  CheckCircle,
  Database,
  Network,
  GitPullRequest,
  type LucideIcon,
} from 'lucide-react';
import { useToast } from '../lib/toast';
import ExplanationCard from './ExplanationCard';
import { fetchPersonas, type PersonaView } from '../lib/personas';
import { explainEndReason } from '@ghostiq/shared/explain';

interface DashboardViewProps {
  project: Project;
  refresh: () => void;
  /** Opens a run in Test Sessions. */
  onOpenSession?: (sessionId: string) => void;
}

function StatTile({
  label,
  value,
  hint,
  Icon,
  tint,
  color,
  meter,
}: {
  label: string;
  value: string;
  hint: string;
  Icon: LucideIcon;
  tint: string;
  color: string;
  meter?: number;
}) {
  return (
    <div
      className="glass-card"
      style={{ padding: '1.1rem 1.2rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '0.8rem', color: 'hsl(var(--text-muted))', fontWeight: 520 }}>
          {label}
        </span>
        <span
          className="stat-icon"
          style={{ background: tint, color, width: 32, height: 32, borderRadius: 9 }}
        >
          <Icon size={16} aria-hidden />
        </span>
      </div>
      <div>
        <div className="stat-value">{value}</div>
        <div style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>{hint}</div>
      </div>
      {meter !== undefined && (
        <div
          role="meter"
          aria-label={`${label} ${value}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(meter * 100)}
          style={{
            height: 4,
            borderRadius: 4,
            background: 'rgba(255,255,255,0.06)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{ width: `${meter * 100}%`, height: '100%', background: color, borderRadius: 4 }}
          />
        </div>
      )}
    </div>
  );
}

export default function DashboardView({ project, refresh, onOpenSession }: DashboardViewProps) {
  const notify = useToast();
  const [targetUrl, setTargetUrl] = useState('http://localhost:3000');
  const [personas, setPersonas] = useState<PersonaView[]>([]);
  const [personaId, setPersonaId] = useState('happy-path');
  const [seed, setSeed] = useState('');
  const [consent, setConsent] = useState(false);
  const [goal, setGoal] = useState('Sign in with valid credentials and reach the dashboard.');
  const selectedPersona = personas.find((p) => p.id === personaId);

  useEffect(() => {
    fetchPersonas()
      .then(setPersonas)
      .catch((err: Error) => setErrorMsg(err.message));
  }, []);

  const choosePersona = (id: string) => {
    setPersonaId(id);
    setConsent(false);
    const goalOfPersona = personas.find((p) => p.id === id)?.spec.goals[0];
    if (goalOfPersona) setGoal(goalOfPersona);
  };
  const [maxSteps, setMaxSteps] = useState(30);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [ciTab, setCiTab] = useState<'action' | 'cli'>('action');
  const [copied, setCopied] = useState(false);
  const ciSnippet =
    ciTab === 'action'
      ? `# .github/workflows/ghostiq.yml (start your app first)
- uses: Abhishek-dotcom15/Ghost-IQ@v0.9.0
  with:
    target: ${targetUrl}
    personas: ${personaId}
    fail-on: high
    llm-provider: gemini
    llm-api-key: \${{ secrets.GEMINI_API_KEY }}`
      : `ghostiq run -t ${targetUrl} -p ${personaId} --fail-on high
# exit 0 pass · 1 findings · 2 config · 3 GhostIQ could not run`;
  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(ciSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  // Calculate high-level project telemetry
  // Totals over all runs (project.sessions holds only the most recent few).
  const totalRuns = project.stats?.total ?? project.sessions.length;
  const successRuns =
    project.stats?.passed ?? project.sessions.filter((s) => s.status === 'PASSED').length;
  const failRuns =
    project.stats?.failed ?? project.sessions.filter((s) => s.status === 'FAILED').length;
  const finished = successRuns + failRuns;
  const passRate = finished > 0 ? Math.round((successRuns / finished) * 100) : 100;

  const handleLaunchTest = async (e: React.FormEvent) => {
    e.preventDefault();
    setTriggering(true);
    setErrorMsg('');

    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          targetUrl,
          personaId,
          goal,
          budgets: { maxSteps },
          allowDestructive,
          ...(seed.trim() ? { seed: Number(seed) } : {}),
          ...(selectedPersona?.spec.requires_consent ? { consent } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start session');
      }

      refresh();
      notify({
        tone: 'success',
        title: 'Run started',
        body: `${selectedPersona?.name ?? personaId} is testing ${targetUrl}.`,
        action: onOpenSession
          ? { label: 'Watch it live', onClick: () => onOpenSession(data.id) }
          : undefined,
      });
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Key numbers */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
        }}
      >
        <StatTile
          label="Total Test Runs"
          value={String(totalRuns)}
          hint={project.stats?.running ? `${project.stats.running} running now` : 'all time'}
          Icon={PlayCircle}
          tint="var(--accent-soft)"
          color="hsl(var(--accent-purple))"
        />
        <StatTile
          label="Pass Rate"
          value={`${passRate}%`}
          hint={`${successRuns} of ${finished} finished runs`}
          Icon={CheckCircle}
          tint="rgba(45, 212, 160, 0.12)"
          color="hsl(var(--success))"
          meter={finished ? successRuns / finished : undefined}
        />
        <StatTile
          label="Failed Sessions"
          value={String(failRuns)}
          hint="each explains why it stopped"
          Icon={ShieldAlert}
          tint="rgba(244, 80, 110, 0.12)"
          color="hsl(var(--danger))"
        />
        <StatTile
          label="Discovered Routes"
          value={String(project._count?.endpoints || 0)}
          hint="API endpoints observed"
          Icon={Database}
          tint="rgba(56, 189, 248, 0.12)"
          color="hsl(var(--info))"
        />
      </section>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr 1fr',
          gap: '2rem',
          alignItems: 'start',
        }}
      >
        {/* Run Test Suite Form */}
        <section
          className="glass-card"
          style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}
        >
          <h3
            style={{
              fontFamily: 'var(--font-title)',
              fontSize: '1.25rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <Network size={18} style={{ color: 'hsl(var(--accent-purple))' }} /> Launch a test run
          </h3>

          {!project.agentOnline && (
            <ExplanationCard
              compact
              explanation={{
                tone: 'warning',
                title: 'No runner connected',
                detail:
                  'Runs need a runner: the process that drives the browser on a machine that can reach your app.',
                fix: `Start one in a terminal: ghostiq agent -k ${project.id} (from the GhostIQ folder: pnpm --filter @ghostiq/runner start -k ${project.id}).`,
              }}
            />
          )}

          {errorMsg && (
            <div
              style={{
                background: 'rgba(244, 63, 94, 0.08)',
                border: '1px solid rgba(244, 63, 94, 0.2)',
                padding: '0.75rem 1rem',
                borderRadius: 'var(--radius-sm)',
                color: 'hsl(var(--danger))',
                fontSize: '0.85rem',
              }}
            >
              {errorMsg}
            </div>
          )}

          <form
            onSubmit={handleLaunchTest}
            style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Target URL under test</label>
              <input
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                required
                placeholder="http://localhost:3000"
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.2rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Testing Persona</label>
                <select value={personaId} onChange={(e) => choosePersona(e.target.value)}>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.source === 'custom' ? ' (custom)' : ''}
                    </option>
                  ))}
                </select>
                {selectedPersona && (
                  <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                    {selectedPersona.description}
                  </span>
                )}
              </div>
            </div>

            {selectedPersona?.spec.requires_consent && (
              <label
                style={{
                  fontSize: '0.8rem',
                  display: 'flex',
                  gap: '0.5rem',
                  alignItems: 'flex-start',
                  color: 'hsl(var(--warning))',
                }}
              >
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                I own this application or am authorised to run security hygiene checks against{' '}
                {targetUrl}.
              </label>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Autonomous Testing Goal</label>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={3}
                required
                placeholder="Instruct the AI agent on what workflows to stress test..."
              />
            </div>

            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <label
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                Max actions
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={maxSteps}
                  onChange={(e) =>
                    setMaxSteps(Math.max(1, Math.min(200, Number(e.target.value) || 1)))
                  }
                  style={{ width: '5rem' }}
                />
              </label>
              <label
                style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                title="When off, clicks on delete/pay/purchase-like controls are skipped and recorded"
              >
                <input
                  type="checkbox"
                  checked={allowDestructive}
                  onChange={(e) => setAllowDestructive(e.target.checked)}
                />
                Allow destructive actions (delete, pay, purchase)
              </label>
              <label
                style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                title="Same persona + same seed = same generated inputs, pacing and behaviors. Leave empty for the persona's own seed."
              >
                Seed
                <input
                  type="number"
                  min={0}
                  value={seed}
                  placeholder={selectedPersona ? String(selectedPersona.spec.seed) : ''}
                  onChange={(e) => setSeed(e.target.value)}
                  style={{ width: '6rem' }}
                />
              </label>
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={!project.agentOnline || triggering}
              style={{ alignSelf: 'flex-start', marginTop: '0.5rem' }}
            >
              <PlayCircle size={16} /> {triggering ? 'Launching runner...' : 'Execute Test Session'}
            </button>
          </form>
        </section>

        {/* GitHub Exporter Card */}
        <section
          className="glass-card"
          style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
        >
          <h3
            style={{
              fontFamily: 'var(--font-title)',
              fontSize: '1.15rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <GitPullRequest size={18} style={{ color: 'hsl(var(--accent-purple))' }} /> Run GhostIQ
            on every pull request
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'hsl(var(--text-muted))', lineHeight: '1.4' }}>
            Add the GhostIQ GitHub Action to your repository: each pull request gets one GhostIQ
            comment with the findings, plus HTML / JUnit / SARIF reports, and the check fails on
            findings at or above the threshold. The same runs anywhere with the CLI. This uses the
            target and persona selected above.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {(['action', 'cli'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setCiTab(t)}
                className={`btn ${ciTab === t ? 'btn-primary' : 'btn-secondary'}`}
                style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem' }}
                aria-pressed={ciTab === t}
              >
                {t === 'action' ? 'GitHub Action' : 'Command line'}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void copySnippet()}
              className="btn btn-secondary"
              style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem', marginLeft: 'auto' }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre
            className="code-block"
            style={{ fontSize: '0.75rem', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}
          >
            {ciSnippet}
          </pre>
          <p style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
            Setup guide: docs/CI.md in the repository.
          </p>
        </section>
      </div>

      {/* Recent Runs Table */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <section
          className="glass-card"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5rem',
            maxHeight: '680px',
            overflowY: 'auto',
          }}
        >
          <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.25rem' }}>
            Recent Activity Logs
          </h3>

          {project.sessions.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '3rem 1rem',
                color: 'hsl(var(--text-muted))',
                fontSize: '0.9rem',
              }}
            >
              No test sessions logged yet. Customize your options and start a test run above.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {project.sessions.map((session, idx) => (
                <div
                  key={session.id || idx}
                  style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid var(--border-glass)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                    transition: 'var(--transition-smooth)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{session.name}</span>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      {session.flakinessScore > 0 && (
                        <span className="badge badge-warning" style={{ fontSize: '0.65rem' }}>
                          FLAKY: {Math.round(session.flakinessScore)}%
                        </span>
                      )}
                      {session.isBaseline && (
                        <span className="badge badge-success" style={{ fontSize: '0.65rem' }}>
                          BASELINE
                        </span>
                      )}
                      <span
                        className={`badge ${
                          session.status === 'PASSED'
                            ? 'badge-success'
                            : session.status === 'FAILED'
                              ? 'badge-danger'
                              : 'badge-warning'
                        }`}
                      >
                        {session.status}
                      </span>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.75rem',
                      color: 'hsl(var(--text-muted))',
                    }}
                  >
                    <span>
                      Persona: <strong style={{ color: '#fff' }}>{session.persona}</strong>
                    </span>
                    <span>
                      {new Date(session.startedAt).toLocaleDateString()} at{' '}
                      {new Date(session.startedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  {session.status !== 'PASSED' &&
                    session.status !== 'RUNNING' &&
                    session.endReason && (
                      <div style={{ fontSize: '0.8rem', color: 'hsl(var(--text-primary))' }}>
                        <strong>
                          {explainEndReason(session.endReason, { summary: session.summary })?.title}
                        </strong>
                        <span style={{ color: 'hsl(var(--text-muted))' }}>
                          {' '}
                          · details and what to do in Test Sessions
                        </span>
                      </div>
                    )}

                  <div
                    style={{
                      borderTop: '1px solid var(--border-glass)',
                      paddingTop: '0.5rem',
                      fontSize: '0.75rem',
                      color: 'hsl(var(--text-muted))',
                    }}
                  >
                    URL:{' '}
                    <code style={{ color: 'hsl(var(--info))', fontFamily: 'var(--font-mono)' }}>
                      {session.targetUrl}
                    </code>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
