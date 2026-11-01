import React, { useState, useEffect } from 'react';
import { Project } from '../App';
import { Play, Activity, Clock, FileText, CheckCircle2, XCircle, ChevronDown, ChevronRight, Terminal, AlertTriangle, Cpu, Sparkles } from 'lucide-react';
import { Socket } from 'socket.io-client';

interface SessionsViewProps {
  project: Project;
  socket: Socket;
}

interface TestStep {
  id: string;
  stepNumber: number;
  action: string;
  description: string;
  selector?: string;
  value?: string;
  status: 'PASSED' | 'FAILED';
  error?: string;
  screenshotPath?: string;
  networkLogs: Array<{ url: string; method: string; status: number; latencyMs: number }>;
}

interface SessionDetail {
  id: string;
  name: string;
  targetUrl: string;
  persona: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  steps: TestStep[];
}

export default function SessionsView({ project, socket }: SessionsViewProps) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [baselineDetail, setBaselineDetail] = useState<SessionDetail | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({});
  const [activeTab, setActiveTab] = useState<'trace' | 'visual' | 'a11y' | 'diagnostics'>('trace');
  const [aiReport, setAiReport] = useState<string | null>(null);

  // Load project sessions list
  const fetchSessions = async () => {
    try {
      const res = await fetch(`http://localhost:3001/api/projects/${project.id}`);
      const data = await res.json();
      setSessions(data.sessions || []);
      if (data.sessions && data.sessions.length > 0 && !selectedSessionId) {
        setSelectedSessionId(data.sessions[0].id);
      }
    } catch (err) {
      console.error('Failed to load project details:', err);
    }
  };

  // Load selected session trace steps
  const fetchSessionDetail = async (id: string) => {
    try {
      const res = await fetch(`http://localhost:3001/api/sessions/${id}`);
      const data = await res.json();
      setSessionDetail(data);
      // Auto expand failed steps
      const expansions: Record<number, boolean> = {};
      data.steps.forEach((s: TestStep) => {
        if (s.status === 'FAILED') expansions[s.stepNumber] = true;
      });
      setExpandedSteps(expansions);
      setAiReport(null);
    } catch (err) {
      console.error('Failed to load session details:', err);
    }
  };

  const fetchBaseline = async (projId: string, url: string, persona: string) => {
    try {
      const res = await fetch(`http://localhost:3001/api/projects/${projId}/baseline?targetUrl=${encodeURIComponent(url)}&persona=${encodeURIComponent(persona)}`);
      if (res.ok) {
        const data = await res.json();
        setBaselineDetail(data);
      } else {
        setBaselineDetail(null);
      }
    } catch (e) {
      setBaselineDetail(null);
    }
  };

  const handleSetBaseline = async () => {
    if (!sessionDetail) return;
    try {
      const res = await fetch(`http://localhost:3001/api/sessions/${sessionDetail.id}/set-baseline`, {
        method: 'POST'
      });
      if (res.ok) {
        alert('This session has been set as the project baseline for this persona/URL configuration.');
        fetchSessionDetail(sessionDetail.id);
        fetchSessions();
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, [project.id]);

  useEffect(() => {
    if (selectedSessionId) {
      fetchSessionDetail(selectedSessionId);
    } else {
      setSessionDetail(null);
      setBaselineDetail(null);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    if (sessionDetail) {
      fetchBaseline(project.id, sessionDetail.targetUrl, sessionDetail.persona);
    }
  }, [sessionDetail?.id]);

  // Subscribe to real-time WebSockets events for active session updates
  useEffect(() => {
    if (!selectedSessionId) return;

    const eventName = `session-update:${selectedSessionId}`;

    socket.on(eventName, (event: { type: string; data: any }) => {
      console.log('WS Event received:', event.type, event.data);

      if (event.type === 'step-started') {
        setSessionDetail(prev => {
          if (!prev) return null;
          // Add temporary loading step placeholder
          const stepPlaceholder: TestStep = {
            id: `temp-${event.data.stepNumber}`,
            stepNumber: event.data.stepNumber,
            action: event.data.action,
            description: event.data.description,
            status: 'PASSED',
            networkLogs: []
          };
          return {
            ...prev,
            status: 'RUNNING',
            steps: [...prev.steps.filter(s => s.stepNumber !== event.data.stepNumber), stepPlaceholder]
          };
        });
      } 
      
      else if (event.type === 'step-completed') {
        setSessionDetail(prev => {
          if (!prev) return null;
          const completedStep: TestStep = {
            id: event.data.id || `completed-${event.data.stepNumber}`,
            stepNumber: event.data.stepNumber,
            action: event.data.action,
            description: event.data.description,
            selector: event.data.selector,
            value: event.data.value,
            status: event.data.status,
            error: event.data.error,
            screenshotPath: event.data.screenshotPath,
            a11yViolations: event.data.a11yViolations,
            networkLogs: event.data.networkLogs || []
          };
          
          const updatedSteps = [...prev.steps.filter(s => s.stepNumber !== event.data.stepNumber), completedStep];
          updatedSteps.sort((a, b) => a.stepNumber - b.stepNumber);

          // Auto expand if failed
          if (completedStep.status === 'FAILED') {
            setExpandedSteps(exp => ({ ...exp, [completedStep.stepNumber]: true }));
          }

          return {
            ...prev,
            steps: updatedSteps
          };
        });
      } 
      
      else if (event.type === 'session-completed') {
        setSessionDetail(prev => {
          if (!prev) return null;
          return {
            ...prev,
            status: event.data.status,
            endedAt: new Date().toISOString()
          };
        });
        // Reload sessions list in sidebar
        fetchSessions();
      } 
      
      else if (event.type === 'diagnostics-ready') {
        setAiReport(event.data.diagnostics);
      }
    });

    return () => {
      socket.off(eventName);
    };
  }, [selectedSessionId, socket]);

  const toggleStep = (stepNumber: number) => {
    setExpandedSteps(prev => ({
      ...prev,
      [stepNumber]: !prev[stepNumber]
    }));
  };

  const getLatestScreenshot = () => {
    if (!sessionDetail || sessionDetail.steps.length === 0) return null;
    // Find last step that has a screenshot
    for (let i = sessionDetail.steps.length - 1; i >= 0; i--) {
      if (sessionDetail.steps[i].screenshotPath) {
        return `http://localhost:3001${sessionDetail.steps[i].screenshotPath}`;
      }
    }
    return null;
  };

  const renderSimpleMarkdown = (mdText: string) => {
    // Basic parser for lists, bolding, and headers
    const lines = mdText.split('\n');
    return lines.map((line, idx) => {
      if (line.startsWith('### ')) {
        return <h4 key={idx} style={{ fontFamily: 'var(--font-title)', fontSize: '1.15rem', color: 'hsl(var(--accent-purple))', marginTop: '1rem', marginBottom: '0.5rem' }}>{line.replace('### ', '')}</h4>;
      }
      if (line.startsWith('#### ')) {
        return <h5 key={idx} style={{ fontFamily: 'var(--font-title)', fontSize: '1rem', color: '#fff', marginTop: '0.75rem', marginBottom: '0.25rem' }}>{line.replace('#### ', '')}</h5>;
      }
      if (line.startsWith('**') && line.endsWith('**')) {
        return <p key={idx} style={{ margin: '0.4rem 0', fontWeight: 700 }}>{line.replace(/\*\*/g, '')}</p>;
      }
      if (line.trim().startsWith('- ')) {
        return <li key={idx} style={{ marginLeft: '1.5rem', margin: '0.25rem 0', listStyleType: 'square' }}>{line.trim().replace('- ', '')}</li>;
      }
      if (line.startsWith('1. ') || line.startsWith('2. ') || line.startsWith('3. ') || line.startsWith('4. ')) {
        return <p key={idx} style={{ marginLeft: '1rem', margin: '0.4rem 0' }}><strong>{line.split(' ')[0]}</strong> {line.split(' ').slice(1).join(' ')}</p>;
      }
      if (line.startsWith('`') && line.endsWith('`')) {
        return <pre key={idx} className="code-block" style={{ margin: '0.5rem 0' }}>{line.replace(/\`/g, '')}</pre>;
      }
      return <p key={idx} style={{ margin: '0.4rem 0', fontSize: '0.9rem', lineHeight: '1.5' }}>{line}</p>;
    });
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '2rem', minHeight: '60vh', alignItems: 'start' }}>
      
      {/* Sessions Left Sidebar */}
      <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1rem', maxHeight: '70vh', overflowY: 'auto' }}>
        <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem' }}>
          Test Suite History
        </h3>

        {sessions.length === 0 ? (
          <div style={{ padding: '2rem 1rem', textShadow: 'center', color: 'hsl(var(--text-muted))', fontSize: '0.85rem' }}>
            No sessions logged yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {sessions.map(s => {
              const active = selectedSessionId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setSelectedSessionId(s.id)}
                  style={{
                    textAlign: 'left',
                    background: active ? 'rgba(139, 92, 246, 0.1)' : 'rgba(255,255,255,0.02)',
                    border: active ? '1px solid hsl(var(--accent-purple))' : '1px solid var(--border-glass)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.75rem',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.4rem',
                    transition: 'var(--transition-smooth)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.85rem', color: active ? '#fff' : 'hsl(var(--text-primary))' }}>
                      {s.name.split(' - ')[1] || s.name}
                    </span>
                    <span style={{ fontSize: '0.65rem' }} className={`badge ${
                      s.status === 'PASSED' ? 'badge-success' : 
                      s.status === 'FAILED' ? 'badge-danger' : 'badge-warning'
                    }`}>
                      {s.status}
                    </span>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: 'hsl(var(--text-muted))' }}>
                    Persona: {s.persona}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Session Execution Details Main Workspace */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        
        {!sessionDetail ? (
          <div className="glass-card" style={{ padding: '5rem', textShadow: 'center', color: 'hsl(var(--text-muted))' }}>
            Select a test session trace log from the sidebar to inspect execution steps.
          </div>
        ) : (
          <>
            
            {/* Header Widget */}
            <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span className={`badge ${
                  sessionDetail.status === 'PASSED' ? 'badge-success' : 
                  sessionDetail.status === 'FAILED' ? 'badge-danger' : 'badge-warning'
                }`} style={{ marginBottom: '0.5rem' }}>
                  {sessionDetail.status === 'RUNNING' && <Activity size={12} className="pulse-running" style={{ marginRight: '0.25rem' }} />}
                  {sessionDetail.status}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.45rem', fontWeight: 700 }}>
                    {sessionDetail.name}
                  </h3>
                  {sessionDetail.isBaseline ? (
                    <span className="badge badge-success" style={{ fontSize: '0.7rem' }}>PROJECT BASELINE</span>
                  ) : (
                    <button onClick={handleSetBaseline} className="btn btn-secondary" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                      Mark as Baseline
                    </button>
                  )}
                </div>
                <p style={{ fontSize: '0.8rem', color: 'hsl(var(--text-muted))', marginTop: '0.2rem' }}>
                  Target: <a href={sessionDetail.targetUrl} target="_blank" rel="noreferrer" style={{ color: 'hsl(var(--info))', textDecoration: 'none' }}>
                    {sessionDetail.targetUrl}
                  </a>
                </p>
              </div>

              <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'hsl(var(--text-muted))' }}>
                {sessionDetail.flakinessScore > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                    <span>Flakiness Index</span>
                    <strong style={{ color: 'hsl(var(--danger))', marginTop: '0.1rem' }}>{Math.round(sessionDetail.flakinessScore)}%</strong>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <span>Persona</span>
                  <strong style={{ color: '#fff', marginTop: '0.1rem' }}>{sessionDetail.persona}</strong>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <span>Started</span>
                  <span style={{ color: '#fff', marginTop: '0.1rem' }}>
                    {new Date(sessionDetail.startedAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            </div>

            {/* Live screen stream & loading indicators */}
            {sessionDetail.status === 'RUNNING' && (
              <div className="glass-card glow-card" style={{
                background: 'rgba(139, 92, 246, 0.03)',
                borderColor: 'hsl(var(--accent-purple))',
                display: 'flex',
                alignItems: 'center',
                gap: '1.5rem'
              }}>
                <div className="pulse-running"></div>
                <div style={{ flex: 1 }}>
                  <h4 style={{ fontSize: '0.95rem', fontWeight: 600 }}>Active Agent Running Local Execution...</h4>
                  <p style={{ fontSize: '0.8rem', color: 'hsl(var(--text-muted))', marginTop: '0.15rem' }}>
                    Web browser launched. Monitoring DOM state and network queries.
                  </p>
                </div>
              </div>
            )}

            {/* Split Panel: Left (Timeline Steps) / Right (Live screen preview) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '1.5rem', alignItems: 'start' }}>
              
              {/* Timeline Steps Card */}
              <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                
                {/* Tabs selection */}
                <div style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem', overflowX: 'auto' }}>
                  <button 
                    onClick={() => setActiveTab('trace')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: activeTab === 'trace' ? 'hsl(var(--accent-purple))' : 'hsl(var(--text-muted))',
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      borderBottom: activeTab === 'trace' ? '2px solid hsl(var(--accent-purple))' : 'none',
                      paddingBottom: '0.4rem',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    <FileText size={16} /> Step Trace ({sessionDetail.steps.length})
                  </button>
                  
                  <button 
                    onClick={() => setActiveTab('visual')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: activeTab === 'visual' ? 'hsl(var(--accent-purple))' : 'hsl(var(--text-muted))',
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      borderBottom: activeTab === 'visual' ? '2px solid hsl(var(--accent-purple))' : 'none',
                      paddingBottom: '0.4rem',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    👁️ Visual Regression
                  </button>

                  <button 
                    onClick={() => setActiveTab('a11y')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: activeTab === 'a11y' ? 'hsl(var(--accent-purple))' : 'hsl(var(--text-muted))',
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      borderBottom: activeTab === 'a11y' ? '2px solid hsl(var(--accent-purple))' : 'none',
                      paddingBottom: '0.4rem',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    ♿ Accessibility Audits ({sessionDetail.steps.reduce((acc, s) => acc + (s.a11yViolations ? JSON.parse(s.a11yViolations).length : 0), 0)})
                  </button>

                  {sessionDetail.status === 'FAILED' && (
                    <button 
                      onClick={() => setActiveTab('diagnostics')}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: activeTab === 'diagnostics' ? 'hsl(var(--accent-purple))' : 'hsl(var(--text-muted))',
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontSize: '0.9rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        borderBottom: activeTab === 'diagnostics' ? '2px solid hsl(var(--accent-purple))' : 'none',
                        paddingBottom: '0.4rem',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      <Cpu size={16} /> <Sparkles size={14} style={{ color: 'gold' }} /> AI Diagnostics
                    </button>
                  )}
                </div>

                {activeTab === 'trace' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {sessionDetail.steps.map((step) => {
                      const expanded = expandedSteps[step.stepNumber];
                      return (
                        <div 
                          key={step.id} 
                          style={{
                            border: '1px solid var(--border-glass)',
                            borderRadius: 'var(--radius-sm)',
                            background: step.status === 'FAILED' ? 'rgba(244,63,94,0.02)' : 'rgba(255,255,255,0.01)',
                            overflow: 'hidden'
                          }}
                        >
                          {/* Step Header */}
                          <div 
                            onClick={() => toggleStep(step.stepNumber)}
                            style={{
                              padding: '0.85rem 1rem',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              cursor: 'pointer',
                              background: 'rgba(255,255,255,0.01)'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                              <span style={{
                                fontFamily: 'var(--font-title)',
                                fontWeight: 700,
                                fontSize: '0.85rem',
                                color: 'hsl(var(--accent-purple))'
                              }}>
                                STEP {step.stepNumber}
                              </span>
                              <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>
                                {step.description}
                              </span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'hsl(var(--text-muted))' }}>
                                {step.action}
                              </span>
                              {step.status === 'PASSED' ? (
                                <CheckCircle2 size={16} style={{ color: 'hsl(var(--success))' }} />
                              ) : (
                                <XCircle size={16} style={{ color: 'hsl(var(--danger))' }} />
                              )}
                            </div>
                          </div>

                          {/* Expanded Step Body */}
                          {expanded && (
                            <div style={{ padding: '1rem', borderTop: '1px solid var(--border-glass)', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'rgba(0,0,0,0.1)' }}>
                              
                              {/* Thought summary */}
                              {step.selector && (
                                <div style={{ fontSize: '0.85rem' }}>
                                  <strong>DOM Selector:</strong> <code style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--info))', background: 'rgba(255,255,255,0.02)', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>{step.selector}</code>
                                </div>
                              )}
                              
                              {step.value && (
                                <div style={{ fontSize: '0.85rem' }}>
                                  <strong>Interacted Value:</strong> <code style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--warning))' }}>"{step.value}"</code>
                                </div>
                              )}

                              {step.error && (
                                <div style={{
                                  background: 'rgba(244, 63, 94, 0.08)',
                                  border: '1px solid rgba(244, 63, 94, 0.15)',
                                  padding: '0.75rem',
                                  borderRadius: 'var(--radius-sm)',
                                  fontSize: '0.8rem',
                                  color: 'hsl(var(--danger))',
                                  display: 'flex',
                                  alignItems: 'start',
                                  gap: '0.5rem'
                                }}>
                                  <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>{step.error}</pre>
                                </div>
                              )}

                              {/* Intercepted API Networks Calls table */}
                              {step.networkLogs && step.networkLogs.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'hsl(var(--text-muted))', textTransform: 'uppercase' }}>
                                    Intercepted API Requests during Step
                                  </span>
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem', textAlign: 'left' }}>
                                    <thead>
                                      <tr style={{ borderBottom: '1px solid var(--border-glass)', color: 'hsl(var(--text-muted))' }}>
                                        <th style={{ padding: '0.4rem 0' }}>Method</th>
                                        <th>API Endpoint</th>
                                        <th>Status</th>
                                        <th style={{ textAlign: 'right' }}>Latency</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {step.networkLogs.map((req, idx) => (
                                        <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                                          <td style={{ padding: '0.4rem 0', fontWeight: 700, color: 'hsl(var(--accent-purple))' }}>{req.method}</td>
                                          <td style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--info))', wordBreak: 'break-all' }}>
                                            {req.url.replace(window.location.origin, '')}
                                          </td>
                                          <td>
                                            <span style={{
                                              color: req.status >= 400 || req.status === 0 ? 'hsl(var(--danger))' : 'hsl(var(--success))',
                                              fontWeight: 600
                                            }}>
                                              {req.status === 0 ? 'FAIL' : req.status}
                                            </span>
                                          </td>
                                          <td style={{ textAlign: 'right', color: req.latencyMs > 800 ? 'hsl(var(--warning))' : 'hsl(var(--text-muted))' }}>
                                            {req.latencyMs}ms
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}

                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {activeTab === 'visual' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                    {!baselineDetail ? (
                      <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'hsl(var(--text-muted))', fontSize: '0.9rem' }}>
                        No baseline session is set for this configuration yet. Mark a successful session run as the project baseline above to start visual comparisons.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                        <div style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', borderBottom: '1px dashed var(--border-glass)', paddingBottom: '0.5rem' }}>
                          Comparing current run against baseline: <strong style={{ color: '#fff' }}>{baselineDetail.name}</strong> (Set {new Date(baselineDetail.startedAt).toLocaleDateString()})
                        </div>
                        {sessionDetail.steps.map((step) => {
                          const baselineStep = baselineDetail.steps.find(b => b.stepNumber === step.stepNumber);
                          return (
                            <div key={step.id} style={{ border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '1rem', background: 'rgba(255,255,255,0.01)' }}>
                              <h4 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.75rem', color: 'hsl(var(--accent-purple))' }}>
                                Step {step.stepNumber}: {step.description}
                              </h4>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                  <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', fontWeight: 600 }}>BASELINE SNAPSHOT</span>
                                  {baselineStep?.screenshotPath ? (
                                    <img src={`http://localhost:3001${baselineStep.screenshotPath}`} alt="Baseline Step View" style={{ width: '100%', border: '1px solid var(--border-glass)', borderRadius: '4px' }} />
                                  ) : (
                                    <div style={{ height: '100px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--border-glass)', color: 'hsl(var(--text-muted))', fontSize: '0.75rem' }}>No Snapshot</div>
                                  )}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                  <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', fontWeight: 600 }}>CURRENT RUN SNAPSHOT</span>
                                  {step.screenshotPath ? (
                                    <img src={`http://localhost:3001${step.screenshotPath}`} alt="Current Step View" style={{ width: '100%', border: '1px solid var(--border-glass)', borderRadius: '4px' }} />
                                  ) : (
                                    <div style={{ height: '100px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--border-glass)', color: 'hsl(var(--text-muted))', fontSize: '0.75rem' }}>No Snapshot</div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'a11y' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {(() => {
                      const allViolations: Array<{ rule: string; impact: string; description: string; element: string; stepNumber: number }> = [];
                      sessionDetail.steps.forEach(s => {
                        if (s.a11yViolations) {
                          try {
                            const parsed = JSON.parse(s.a11yViolations);
                            parsed.forEach((v: any) => allViolations.push({ ...v, stepNumber: s.stepNumber }));
                          } catch (e) {}
                        }
                      });

                      if (allViolations.length === 0) {
                        return (
                          <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
                            <CheckCircle2 size={36} style={{ color: 'hsl(var(--success))', marginBottom: '0.75rem' }} />
                            <h4 style={{ fontWeight: 600, color: '#fff' }}>Passed Accessibility Audit!</h4>
                            <p style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', marginTop: '0.25rem' }}>
                              No compliance issues found on interactive nodes for this session trace.
                            </p>
                          </div>
                        );
                      }

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <div style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', borderBottom: '1px dashed var(--border-glass)', paddingBottom: '0.5rem' }}>
                            ♿ Detected <strong style={{ color: 'hsl(var(--danger))' }}>{allViolations.length} accessibility warnings</strong> on interactive components.
                          </div>
                          {allViolations.map((v, index) => (
                            <div key={index} style={{
                              border: '1px solid var(--border-glass)',
                              background: 'rgba(255,255,255,0.01)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '1rem',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.6rem'
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#fff' }}>{v.rule}</span>
                                <span className={`badge ${
                                  v.impact === 'critical' ? 'badge-danger' :
                                  v.impact === 'serious' ? 'badge-warning' : 'badge-info'
                                }`} style={{ fontSize: '0.65rem' }}>
                                  {v.impact.toUpperCase()}
                                </span>
                              </div>
                              <p style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))' }}>
                                {v.description} <span style={{ color: 'hsl(var(--accent-purple))', fontWeight: 600 }}>(Detected at Step {v.stepNumber})</span>
                              </p>
                              <pre className="code-block" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                                {v.element}
                              </pre>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {activeTab === 'diagnostics' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem' }}>
                    {aiReport || sessionDetail.steps.some(s => s.status === 'FAILED') ? (
                      <div className="glass-card" style={{
                        background: 'rgba(139, 92, 246, 0.02)',
                        border: '1px solid rgba(139, 92, 246, 0.15)',
                        padding: '1.5rem',
                        borderRadius: 'var(--radius-md)'
                      }}>
                        {aiReport ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {renderSimpleMarkdown(aiReport)}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '2rem 0' }}>
                            <div className="pulse-running" style={{ width: '12px', height: '12px' }}></div>
                            <span style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))' }}>
                              Gemini is analyzing DOM hierarchy, visual state, and console traces. Building diagnostics...
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'hsl(var(--text-muted))', fontSize: '0.9rem' }}>
                        Diagnostics only available for failed test runs.
                      </div>
                    )}
                  </div>
                )}

              </div>

              {/* Live screen preview Card (Right Column) */}
              <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', position: 'sticky', top: '20px' }}>
                <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1rem' }}>Browser Snapshot View</h3>
                
                {getLatestScreenshot() ? (
                  <div style={{
                    border: '1px solid var(--border-glass)',
                    borderRadius: 'var(--radius-sm)',
                    overflow: 'hidden',
                    background: 'black',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: 'inset 0 0 10px rgba(0,0,0,0.8)'
                  }}>
                    <img 
                      src={getLatestScreenshot()!} 
                      alt="Local Runner Snapshot" 
                      style={{ width: '100%', height: 'auto', display: 'block', objectFit: 'contain' }} 
                    />
                  </div>
                ) : (
                  <div style={{
                    height: '200px',
                    border: '1px dashed var(--border-glass)',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'hsl(var(--text-muted))',
                    fontSize: '0.85rem',
                    textAlign: 'center',
                    padding: '1rem'
                  }}>
                    <span>📷</span>
                    <span style={{ marginTop: '0.5rem' }}>No screenshots captured yet. Let the run compile steps.</span>
                  </div>
                )}
                <div style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))', borderTop: '1px solid var(--border-glass)', paddingTop: '0.5rem' }}>
                  🔍 Showcases exact UI state processed by the LLM on the local environment machine.
                </div>
              </div>

            </div>

          </>
        )}

      </section>

    </div>
  );
}
