import React, { useState } from 'react';
import { Project } from '../App';
import { PlayCircle, ShieldAlert, CheckCircle, Database, Network } from 'lucide-react';

interface DashboardViewProps {
  project: Project;
  refresh: () => void;
}

export default function DashboardView({ project, refresh }: DashboardViewProps) {
  const [targetUrl, setTargetUrl] = useState('http://localhost:3000');
  const [persona, setPersona] = useState('Happy Path User');
  const [goal, setGoal] = useState('Sign in to the app, browse items, and complete a checkout flow.');
  const [triggering, setTriggering] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  const [githubRepo, setGithubRepo] = useState('Abhishek-dotcom15/ghostiq');
  const [githubPr, setGithubPr] = useState('1');
  const [prComment, setPrComment] = useState('');

  const handleExportPr = async () => {
    try {
      const res = await fetch(`http://localhost:3001/api/projects/${project.id}/export-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: githubRepo,
          prNumber: githubPr
        })
      });
      const data = await res.json();
      if (res.ok) {
        setPrComment(data.comment);
        alert('CI/CD PR comment exported successfully (Mock Output generated below).');
      } else {
        alert(data.error || 'Failed to export PR check');
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Calculate high-level project telemetry
  const totalRuns = project.sessions.length;
  const successRuns = project.sessions.filter(s => s.status === 'PASSED').length;
  const failRuns = project.sessions.filter(s => s.status === 'FAILED').length;
  const passRate = totalRuns > 0 ? Math.round((successRuns / totalRuns) * 100) : 100;

  const handleLaunchTest = async (e: React.FormEvent) => {
    e.preventDefault();
    setTriggering(true);
    setErrorMsg('');

    try {
      const res = await fetch('http://localhost:3001/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          targetUrl,
          persona,
          goal
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start session');
      }

      // Success - force reload project
      refresh();
      alert(`Test session started successfully! Go to the 'Test Sessions' tab to watch the live runner execution.`);
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Telemetry Metrics Cards */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem' }}>
        
        <div className="glass-card glow-card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ background: 'rgba(139, 92, 246, 0.1)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', color: 'hsl(var(--accent-purple))' }}>
            <PlayCircle size={24} />
          </div>
          <div>
            <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', display: 'block' }}>Total Test Runs</span>
            <span style={{ fontFamily: 'var(--font-title)', fontWeight: 800, fontSize: '1.75rem' }}>{totalRuns}</span>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ background: 'rgba(17, 185, 129, 0.1)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', color: 'hsl(var(--success))' }}>
            <CheckCircle size={24} />
          </div>
          <div>
            <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', display: 'block' }}>Pass Rate</span>
            <span style={{ fontFamily: 'var(--font-title)', fontWeight: 800, fontSize: '1.75rem' }}>
              {passRate}%
            </span>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ background: 'rgba(244, 63, 94, 0.1)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', color: 'hsl(var(--danger))' }}>
            <ShieldAlert size={24} />
          </div>
          <div>
            <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', display: 'block' }}>Failed Sessions</span>
            <span style={{ fontFamily: 'var(--font-title)', fontWeight: 800, fontSize: '1.75rem' }}>{failRuns}</span>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ background: 'rgba(14, 165, 233, 0.1)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', color: 'hsl(var(--info))' }}>
            <Database size={24} />
          </div>
          <div>
            <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', display: 'block' }}>Discovered Routes</span>
            <span style={{ fontFamily: 'var(--font-title)', fontWeight: 800, fontSize: '1.75rem' }}>
              {project._count?.endpoints || 0}
            </span>
          </div>
        </div>

      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '2rem', alignItems: 'start' }}>
        
        {/* Run Test Suite Form */}
        <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Network size={18} style={{ color: 'hsl(var(--accent-purple))' }} /> Trigger Autonomous Tester
          </h3>

          {!project.agentOnline && (
            <div style={{
              background: 'rgba(244, 63, 94, 0.08)',
              border: '1px solid rgba(244, 63, 94, 0.15)',
              padding: '0.75rem 1rem',
              borderRadius: 'var(--radius-sm)',
              color: 'hsl(var(--danger))',
              fontSize: '0.85rem'
            }}>
              ⚠️ <strong>Agent Offline</strong>: Please start the CLI agent in your terminal (using <code>npx ghostiq-agent -k {project.id}</code>) to test local URLs.
            </div>
          )}

          {errorMsg && (
            <div style={{
              background: 'rgba(244, 63, 94, 0.08)',
              border: '1px solid rgba(244, 63, 94, 0.2)',
              padding: '0.75rem 1rem',
              borderRadius: 'var(--radius-sm)',
              color: 'hsl(var(--danger))',
              fontSize: '0.85rem'
            }}>
              {errorMsg}
            </div>
          )}

          <form onSubmit={handleLaunchTest} style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
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
                <select value={persona} onChange={(e) => setPersona(e.target.value)}>
                  <option value="Happy Path User">Happy Path User (Methodical & standard validation)</option>
                  <option value="Chaotic Explorer">Chaotic Explorer (Aggressive clicks & random flows)</option>
                  <option value="Form Stress Tester">Form Stress Tester (Empty & invalid form validation checks)</option>
                </select>
              </div>
            </div>

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
        <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.5rem' }}>
          <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            🐙 Export CI/CD Pull Request Report
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'hsl(var(--text-muted))', lineHeight: '1.4' }}>
            Simulate posting a PR status comment. This compiles recent runs data and posts a check summary directly to GitHub.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '0.75rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <label style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>Repository Path</label>
              <input 
                type="text" 
                placeholder="owner/repo" 
                value={githubRepo} 
                onChange={(e) => setGithubRepo(e.target.value)} 
                style={{ padding: '0.4rem', fontSize: '0.85rem' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <label style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>Pull Request #</label>
              <input 
                type="number" 
                placeholder="PR #" 
                value={githubPr} 
                onChange={(e) => setGithubPr(e.target.value)} 
                style={{ padding: '0.4rem', fontSize: '0.85rem' }}
              />
            </div>
          </div>
          <button 
            onClick={handleExportPr} 
            className="btn btn-secondary" 
            style={{ alignSelf: 'flex-start', fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
            disabled={project.sessions.length === 0}
          >
            Post PR Comment
          </button>
          
          {prComment && (
            <div style={{ marginTop: '0.5rem', borderTop: '1px dashed var(--border-glass)', paddingTop: '0.75rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'hsl(var(--success))', fontWeight: 600 }}>🟢 Mock GitHub Comment Posted:</span>
              <pre className="code-block" style={{ fontSize: '0.75rem', marginTop: '0.4rem', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>
                {prComment}
              </pre>
            </div>
          )}
        </section>
      </div>

      {/* Recent Runs Table */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxHeight: '680px', overflowY: 'auto' }}>
          <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.25rem' }}>Recent Activity Logs</h3>
          
          {project.sessions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'hsl(var(--text-muted))', fontSize: '0.9rem' }}>
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
                    transition: 'var(--transition-smooth)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                      <span className={`badge ${
                        session.status === 'PASSED' ? 'badge-success' : 
                        session.status === 'FAILED' ? 'badge-danger' : 'badge-warning'
                      }`}>
                        {session.status}
                      </span>
                    </div>
                  </div>
                  
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                    <span>Persona: <strong style={{ color: '#fff' }}>{session.persona}</strong></span>
                    <span>{new Date(session.startedAt).toLocaleDateString()} at {new Date(session.startedAt).toLocaleTimeString()}</span>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '0.5rem', fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                    URL: <code style={{ color: 'hsl(var(--info))', fontFamily: 'var(--font-mono)' }}>{session.targetUrl}</code>
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
