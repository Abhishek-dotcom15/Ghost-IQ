import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  PlayCircle,
  BarChart3,
  Bug,
  Users,
  Settings,
  Plus,
  Terminal,
  LineChart,
  Wrench,
  ShieldCheck,
  LogIn,
  LogOut,
  Copy,
  FolderPlus,
  type LucideIcon,
} from 'lucide-react';
import { useToast } from './lib/toast';
import AccessView from './components/AccessView';
import AnalyticsView from './components/AnalyticsView';
import LoginView from './components/LoginView';
import { fetchMe, logout, type Me } from './lib/auth';
import HealsView from './components/HealsView';
import DashboardView from './components/DashboardView';
import SessionsView from './components/SessionsView';
import EndpointsView from './components/EndpointsView';
import PersonaBuilder from './components/PersonaBuilder';
import FindingsView from './components/FindingsView';
import LlmStatusPanel from './components/LlmStatusPanel';
import { io } from 'socket.io-client';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  agentOnline: boolean;
  /** Read-only for anonymous visitors (public demo project). */
  public?: boolean;
  /** Run totals by status, over all runs. */
  stats?: { total: number; passed: number; failed: number; running: number };
  sessions: any[];
  _count?: {
    sessions: number;
    endpoints: number;
  };
}

const socket = io({
  query: { role: 'dashboard' },
});

type View =
  | 'dashboard'
  | 'sessions'
  | 'findings'
  | 'analytics'
  | 'heals'
  | 'endpoints'
  | 'personas'
  | 'access'
  | 'settings';

/** Sidebar groups. Labels are also the buttons' accessible names. */
const NAV: Array<{ label: string; items: Array<{ view: View; label: string; Icon: LucideIcon }> }> =
  [
    {
      label: 'Testing',
      items: [
        { view: 'dashboard', label: 'Overview', Icon: LayoutDashboard },
        { view: 'sessions', label: 'Test Sessions', Icon: PlayCircle },
        { view: 'findings', label: 'Findings', Icon: Bug },
        { view: 'heals', label: 'Heal Review', Icon: Wrench },
      ],
    },
    {
      label: 'Insights',
      items: [
        { view: 'analytics', label: 'Analytics', Icon: LineChart },
        { view: 'endpoints', label: 'API Health', Icon: BarChart3 },
      ],
    },
    {
      label: 'Configure',
      items: [
        { view: 'personas', label: 'Personas Builder', Icon: Users },
        { view: 'access', label: 'Access & Keys', Icon: ShieldCheck },
        { view: 'settings', label: 'Settings', Icon: Settings },
      ],
    },
  ];

const PAGES: Record<View, { title: string; subtitle: string }> = {
  dashboard: {
    title: 'Overview',
    subtitle: 'Launch personas against your app and follow what they find.',
  },
  sessions: {
    title: 'Test Sessions',
    subtitle: 'Every run step by step, with screenshots, replays and exports.',
  },
  findings: { title: 'Findings', subtitle: 'Deduplicated bugs with evidence, ranked by severity.' },
  heals: {
    title: 'Heal Review',
    subtitle: 'Controls that changed since a recording: approve or reject the new locator.',
  },
  analytics: {
    title: 'Analytics',
    subtitle: 'Coverage, persona effectiveness, findings over time and cost.',
  },
  endpoints: {
    title: 'API Health',
    subtitle: 'Latency and errors of every endpoint the personas called.',
  },
  personas: {
    title: 'Personas',
    subtitle: 'Virtual users as YAML: inputs, pacing, devices and behaviours.',
  },
  access: {
    title: 'Access & Keys',
    subtitle: 'API keys for runners and CI, members, visibility and the audit log.',
  },
  settings: { title: 'Settings', subtitle: 'The AI model in use, its health and its spend.' },
};

export default function App() {
  const notify = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [currentView, setCurrentView] = useState<View>(() =>
    new URLSearchParams(window.location.search).has('session') ? 'sessions' : 'dashboard',
  );
  const [newProjectName, setNewProjectName] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  // Live events arrive per project room: (re)join the selected project's room.
  const selectedId = selectedProject?.id;
  useEffect(() => {
    if (!selectedId) return;
    const subscribe = () => socket.emit('subscribe', selectedId);
    subscribe();
    socket.on('connect', subscribe);
    return () => {
      socket.off('connect', subscribe);
    };
  }, [selectedId]);

  const signOut = async () => {
    await logout().catch(() => {});
    window.location.href = '/';
  };
  const anonymous = !!me?.authEnabled && me.principal === 'anonymous';

  // Load Projects
  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      const data = res.ok ? await res.json() : [];
      setProjects(data);
      setLoaded(true);
      if (data.length > 0 && !selectedProject) {
        setSelectedProject(data[0]);
      } else if (selectedProject) {
        // Update currently selected project fields (like agent online status)
        const updated = data.find((p: Project) => p.id === selectedProject.id);
        if (updated) setSelectedProject(updated);
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  };

  useEffect(() => {
    fetchProjects();

    // Listen to real-time agent status changes
    socket.on(
      'agent-status-change',
      (data: { projectId: string; status: 'online' | 'offline' }) => {
        setProjects((prev) =>
          prev.map((p) => {
            if (p.id === data.projectId) {
              const updated = { ...p, agentOnline: data.status === 'online' };
              if (selectedProject && selectedProject.id === p.id) {
                setSelectedProject(updated);
              }
              return updated;
            }
            return p;
          }),
        );
      },
    );

    return () => {
      socket.off('agent-status-change');
    };
  }, [selectedProject]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newProjectName }),
      });
      const newProj = await res.json();
      if (!res.ok) throw new Error(newProj.error ?? `HTTP ${res.status}`);
      setProjects((prev) => [...prev, newProj]);
      setSelectedProject(newProj);
      setNewProjectName('');
      setCreateError(null);
      setShowAddModal(false);
    } catch (err) {
      setCreateError((err as Error).message);
    }
  };

  // Sign-in is on and there is nothing public to show: ask to sign in.
  if (me && anonymous && loaded && (projects.length === 0 || showLogin)) {
    // A full reload reconnects the live socket with the new session cookie.
    return <LoginView me={me} onSignedIn={() => window.location.reload()} />;
  }

  const runnerCommand = selectedProject
    ? `ghostiq agent -k ${selectedProject.id}${me?.authEnabled ? ' --api-key <key>' : ''}`
    : '';
  const copyRunnerCommand = async () => {
    try {
      await navigator.clipboard.writeText(runnerCommand);
      notify({
        tone: 'success',
        title: 'Runner command copied',
        body: 'Paste it into a terminal on the machine that can reach your app.',
      });
    } catch {
      notify({ tone: 'warning', title: 'Could not copy', body: runnerCommand });
    }
  };
  const page = PAGES[currentView];
  const navGroups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.view !== 'access' || (me?.authEnabled && !anonymous)),
  }));

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar" aria-label="Main navigation">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0 0.4rem' }}>
          <div
            aria-hidden
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              display: 'grid',
              placeItems: 'center',
              fontSize: '1.15rem',
              background: 'linear-gradient(135deg, hsl(248, 90%, 68%), hsl(199, 89%, 60%))',
              boxShadow: '0 6px 18px -8px rgba(124,108,255,0.9)',
              flexShrink: 0,
            }}
          >
            👻
          </div>
          <div className="hide-narrow" style={{ lineHeight: 1.15 }}>
            <h1 style={{ fontSize: '1.05rem', fontWeight: 700 }}>GhostIQ</h1>
            <span style={{ fontSize: '0.72rem', color: 'hsl(var(--text-muted))' }}>
              Autonomous QA
            </span>
          </div>
        </div>

        {/* Project switcher */}
        <div
          className="hide-narrow"
          style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}
        >
          <label htmlFor="project-switcher" className="nav-label" style={{ padding: '0 0.3rem' }}>
            Project
          </label>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <select
              id="project-switcher"
              value={selectedProject?.id || ''}
              onChange={(e) => {
                const proj = projects.find((p) => p.id === e.target.value);
                if (proj) setSelectedProject(proj);
              }}
              style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.6rem', fontSize: '0.85rem' }}
            >
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {!anonymous && (
              <button
                onClick={() => setShowAddModal(true)}
                aria-label="New project"
                title="New project"
                className="btn btn-secondary"
                style={{ padding: '0 0.6rem' }}
              >
                <Plus size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', flex: 1 }}>
          {navGroups.map((group) => (
            <div key={group.label} className="nav-section">
              <span className="nav-label">{group.label}</span>
              {group.items.map(({ view, label, Icon }) => (
                <button
                  key={view}
                  onClick={() => setCurrentView(view)}
                  className="nav-item"
                  aria-current={currentView === view ? 'page' : undefined}
                  aria-label={label}
                  title={label}
                >
                  <Icon size={17} aria-hidden />
                  <span className="nav-text">{label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Runner status */}
        {selectedProject && (
          <div
            className="hide-narrow"
            style={{
              border: '1px solid var(--border-glass)',
              background: 'var(--surface-raised)',
              padding: '0.7rem 0.8rem',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.65rem',
            }}
          >
            <div className={selectedProject.agentOnline ? 'pulse-online' : 'pulse-offline'} />
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>Local CLI Agent</span>
              <span style={{ fontSize: '0.72rem', color: 'hsl(var(--text-muted))' }}>
                {selectedProject.agentOnline ? 'Connected' : 'Offline'}
              </span>
            </div>
          </div>
        )}

        {/* Account */}
        {me?.authEnabled && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.55rem',
              fontSize: '0.8rem',
              padding: '0 0.3rem',
            }}
          >
            {anonymous ? (
              <button
                onClick={() => setShowLogin(true)}
                className="btn btn-secondary"
                style={{ width: '100%' }}
              >
                <LogIn size={14} /> Sign in
              </button>
            ) : (
              <>
                {me.user?.avatarUrl ? (
                  <img
                    src={me.user.avatarUrl}
                    alt=""
                    width={26}
                    height={26}
                    style={{ borderRadius: '50%' }}
                  />
                ) : (
                  <span
                    aria-hidden
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: '50%',
                      display: 'grid',
                      placeItems: 'center',
                      background: 'var(--accent-soft)',
                      color: 'hsl(var(--accent-purple))',
                      fontWeight: 700,
                      fontSize: '0.75rem',
                    }}
                  >
                    {(me.user?.login ?? 'A').slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span
                  className="hide-narrow"
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {me.user?.login ?? 'admin'}
                  {me.admin && <span style={{ color: 'hsl(var(--text-muted))' }}> · admin</span>}
                </span>
                <button
                  onClick={() => void signOut()}
                  className="btn btn-ghost"
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.75rem' }}
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut size={14} /> <span className="hide-narrow">Sign out</span>
                </button>
              </>
            )}
          </div>
        )}
      </aside>

      {/* Main */}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header className="topbar">
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: '0.78rem',
                color: 'hsl(var(--text-muted))',
                display: 'flex',
                gap: '0.4rem',
                alignItems: 'center',
              }}
            >
              <span style={{ color: 'hsl(var(--text-primary))', fontWeight: 550 }}>
                {selectedProject?.name || 'No project'}
              </span>
              {selectedProject?.public && <span className="badge badge-info">public</span>}
              <span aria-hidden>/</span>
              <span>{page.title}</span>
            </div>
            <h2 style={{ fontSize: '1.35rem', marginTop: '0.15rem' }}>{page.title}</h2>
            <p
              style={{ color: 'hsl(var(--text-muted))', fontSize: '0.84rem', marginTop: '0.1rem' }}
            >
              {page.subtitle}
            </p>
          </div>

          {selectedProject && (
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span
                className="chip"
                title={
                  selectedProject.agentOnline ? 'A runner is connected' : 'No runner connected'
                }
              >
                <span className={selectedProject.agentOnline ? 'pulse-online' : 'pulse-offline'} />
                Runner {selectedProject.agentOnline ? 'online' : 'offline'}
              </span>
              <button
                className="chip"
                onClick={() => void copyRunnerCommand()}
                title="Copy the command that starts a runner for this project"
                style={{
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.74rem',
                  maxWidth: 420,
                }}
              >
                <Terminal size={13} style={{ color: 'hsl(var(--accent-purple))', flexShrink: 0 }} />
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {runnerCommand}
                </span>
                <Copy size={12} style={{ flexShrink: 0 }} />
              </button>
            </div>
          )}
        </header>

        <div className="page">
          {!selectedProject ? (
            <div
              className="glass-card"
              style={{
                textAlign: 'center',
                padding: '4.5rem 2rem',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.75rem',
              }}
            >
              <div
                aria-hidden
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 16,
                  display: 'grid',
                  placeItems: 'center',
                  background: 'var(--accent-soft)',
                  color: 'hsl(var(--accent-purple))',
                }}
              >
                <FolderPlus size={26} />
              </div>
              <h3 style={{ fontSize: '1.3rem' }}>Create your first project</h3>
              <p style={{ color: 'hsl(var(--text-muted))', maxWidth: 440 }}>
                A project holds the runs, findings and API health of one app. Create one, start a
                runner, then launch a persona from the Overview.
              </p>
              {!anonymous && (
                <button
                  onClick={() => setShowAddModal(true)}
                  className="btn btn-primary"
                  style={{ marginTop: '0.5rem' }}
                >
                  <Plus size={16} /> New Project
                </button>
              )}
            </div>
          ) : (
            <>
              {currentView === 'dashboard' && (
                <DashboardView
                  project={selectedProject}
                  refresh={fetchProjects}
                  onOpenSession={(id) => {
                    window.history.replaceState(null, '', `/?session=${id}`);
                    setCurrentView('sessions');
                  }}
                />
              )}
              {currentView === 'sessions' && (
                <SessionsView project={selectedProject} socket={socket} />
              )}
              {currentView === 'findings' && (
                <FindingsView project={selectedProject} socket={socket} />
              )}
              {currentView === 'analytics' && (
                <AnalyticsView
                  project={selectedProject}
                  socket={socket}
                  onReviewHeals={() => setCurrentView('heals')}
                />
              )}
              {currentView === 'heals' && <HealsView project={selectedProject} socket={socket} />}
              {currentView === 'endpoints' && <EndpointsView project={selectedProject} />}
              {currentView === 'personas' && <PersonaBuilder project={selectedProject} />}
              {currentView === 'access' && me && (
                <AccessView project={selectedProject} me={me} refresh={fetchProjects} />
              )}
              {currentView === 'settings' && <LlmStatusPanel />}
            </>
          )}
        </div>
      </main>

      {/* Create Project Modal */}
      {showAddModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-project-title"
          onKeyDown={(e) => e.key === 'Escape' && setShowAddModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5, 6, 10, 0.72)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <form
            onSubmit={handleCreateProject}
            className="glass-card"
            style={{
              width: '100%',
              maxWidth: 420,
              display: 'flex',
              flexDirection: 'column',
              gap: '1.1rem',
            }}
          >
            <h3 id="new-project-title" style={{ fontSize: '1.15rem' }}>
              Create New Project
            </h3>
            {createError && (
              <p role="alert" style={{ color: 'hsl(var(--danger))', fontSize: '0.85rem' }}>
                {createError}
              </p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.85rem' }}>Project Name</label>
              <input
                type="text"
                placeholder="e.g. My E-commerce WebApp"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div
              style={{
                display: 'flex',
                gap: '0.75rem',
                justifyContent: 'flex-end',
                marginTop: '0.5rem',
              }}
            >
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
