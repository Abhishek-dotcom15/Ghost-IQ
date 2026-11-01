import React, { useState, useEffect } from 'react';
import { LayoutDashboard, PlayCircle, BarChart3, Users, Settings, Plus, Sparkles, Terminal } from 'lucide-react';
import DashboardView from './components/DashboardView';
import SessionsView from './components/SessionsView';
import EndpointsView from './components/EndpointsView';
import PersonaBuilder from './components/PersonaBuilder';
import { io } from 'socket.io-client';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  agentOnline: boolean;
  sessions: any[];
  _count?: {
    sessions: number;
    endpoints: number;
  };
}

const socket = io('http://localhost:3001', {
  query: { role: 'dashboard' }
});

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [currentView, setCurrentView] = useState<'dashboard' | 'sessions' | 'endpoints' | 'personas' | 'settings'>('dashboard');
  const [newProjectName, setNewProjectName] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState(localStorage.getItem('GEMINI_API_KEY') || '');

  // Load Projects
  const fetchProjects = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/projects');
      const data = await res.json();
      setProjects(data);
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
    socket.on('agent-status-change', (data: { projectId: string; status: 'online' | 'offline' }) => {
      setProjects(prev => prev.map(p => {
        if (p.id === data.projectId) {
          const updated = { ...p, agentOnline: data.status === 'online' };
          if (selectedProject && selectedProject.id === p.id) {
            setSelectedProject(updated);
          }
          return updated;
        }
        return p;
      }));
    });

    return () => {
      socket.off('agent-status-change');
    };
  }, [selectedProject]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    try {
      const res = await fetch('http://localhost:3001/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newProjectName })
      });
      const newProj = await res.json();
      setProjects(prev => [...prev, newProj]);
      setSelectedProject(newProj);
      setNewProjectName('');
      setShowAddModal(false);
    } catch (err) {
      console.error('Failed to create project:', err);
    }
  };

  const handleSaveApiKey = () => {
    localStorage.setItem('GEMINI_API_KEY', geminiApiKey);
    alert('API Key saved successfully! The central server service can read it from .env or your dashboard settings.');
  };

  return (
    <div className="app-container" style={{ display: 'flex', minHeight: '100vh', background: 'hsl(var(--bg-primary))' }}>
      
      {/* Sidebar Navigation */}
      <aside style={{
        width: '260px',
        borderRight: '1px solid var(--border-glass)',
        background: 'hsl(var(--bg-secondary))',
        padding: '1.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '2rem'
      }}>
        
        {/* Brand Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '2rem' }}>👻</span>
          <div>
            <h1 style={{ fontFamily: 'var(--font-title)', fontWeight: 800, fontSize: '1.35rem', letterSpacing: '-0.5px' }}>
              GhostIQ
            </h1>
            <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'hsl(var(--accent-purple))', fontWeight: 700, letterSpacing: '1px' }}>
              Autonomous QA
            </span>
          </div>
        </div>

        {/* Project Selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'hsl(var(--text-muted))', textTransform: 'uppercase' }}>
            Current Project
          </label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <select 
              value={selectedProject?.id || ''} 
              onChange={(e) => {
                const proj = projects.find(p => p.id === e.target.value);
                if (proj) setSelectedProject(proj);
              }}
              style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-sm)' }}
            >
              {projects.length === 0 && <option value="">No Projects Configured</option>}
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button 
              onClick={() => setShowAddModal(true)} 
              style={{
                width: '38px',
                height: '38px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid var(--border-glass)',
                borderRadius: 'var(--radius-sm)',
                color: '#fff',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'var(--transition-smooth)'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.1)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'}
            >
              <Plus size={18} />
            </button>
          </div>
        </div>

        {/* Nav Links */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
          <button 
            onClick={() => setCurrentView('dashboard')}
            className={`btn ${currentView === 'dashboard' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ justifyContent: 'flex-start', width: '100%' }}
          >
            <LayoutDashboard size={18} /> Overview
          </button>
          
          <button 
            onClick={() => setCurrentView('sessions')}
            className={`btn ${currentView === 'sessions' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ justifyContent: 'flex-start', width: '100%' }}
          >
            <PlayCircle size={18} /> Test Sessions
          </button>
          
          <button 
            onClick={() => setCurrentView('endpoints')}
            className={`btn ${currentView === 'endpoints' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ justifyContent: 'flex-start', width: '100%' }}
          >
            <BarChart3 size={18} /> API Health
          </button>
          
          <button 
            onClick={() => setCurrentView('personas')}
            className={`btn ${currentView === 'personas' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ justifyContent: 'flex-start', width: '100%' }}
          >
            <Users size={18} /> Personas Builder
          </button>
          
          <button 
            onClick={() => setCurrentView('settings')}
            className={`btn ${currentView === 'settings' ? 'btn-primary' : 'btn-secondary'}`}
            style={{ justifyContent: 'flex-start', width: '100%', marginTop: 'auto' }}
          >
            <Settings size={18} /> Settings
          </button>
        </nav>

        {/* Local Agent Status */}
        {selectedProject && (
          <div style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid var(--border-glass)',
            padding: '1rem',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem'
          }}>
            <div className={selectedProject.agentOnline ? 'pulse-online' : 'pulse-offline'}></div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>Local CLI Agent</span>
              <span style={{ fontSize: '0.65rem', color: 'hsl(var(--text-muted))' }}>
                {selectedProject.agentOnline ? 'Connected' : 'Offline'}
              </span>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <main style={{ flex: 1, padding: '2.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        
        {/* Header Panel */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '1rem' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-title)', fontWeight: 700, fontSize: '1.75rem' }}>
              {currentView === 'dashboard' && 'Project Summary'}
              {currentView === 'sessions' && 'Autonomous Test Suites'}
              {currentView === 'endpoints' && 'API Analytics'}
              {currentView === 'personas' && 'AI Personas'}
              {currentView === 'settings' && 'Platform Settings'}
            </h2>
            <p style={{ color: 'hsl(var(--text-muted))', fontSize: '0.9rem', marginTop: '0.2rem' }}>
              Active Project: <span style={{ color: 'hsl(var(--text-primary))', fontWeight: 500 }}>{selectedProject?.name || 'None'}</span>
            </p>
          </div>

          {/* Quick status bar */}
          <div style={{ display: 'flex', gap: '1rem' }}>
            {selectedProject && (
              <div className="glass-card" style={{ padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                <Terminal size={14} style={{ color: 'hsl(var(--accent-purple))' }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                  npx ghostiq-agent -k {selectedProject.id}
                </span>
              </div>
            )}
          </div>
        </header>

        {/* View Routing */}
        {!selectedProject ? (
          <div className="glass-card" style={{ textAlign: 'center', padding: '5rem 2rem' }}>
            <span style={{ fontSize: '3rem' }}>📁</span>
            <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.5rem', marginTop: '1rem' }}>Create a Project to Get Started</h3>
            <p style={{ color: 'hsl(var(--text-muted))', marginTop: '0.5rem', marginBottom: '1.5rem' }}>
              Each project holds session histories, agent actions, and discovered endpoints.
            </p>
            <button onClick={() => setShowAddModal(true)} className="btn btn-primary">
              <Plus size={16} /> New Project
            </button>
          </div>
        ) : (
          <>
            {currentView === 'dashboard' && <DashboardView project={selectedProject} refresh={fetchProjects} />}
            {currentView === 'sessions' && <SessionsView project={selectedProject} socket={socket} />}
            {currentView === 'endpoints' && <EndpointsView project={selectedProject} />}
            {currentView === 'personas' && <PersonaBuilder />}
            {currentView === 'settings' && (
              <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '600px' }}>
                <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Sparkles size={18} style={{ color: 'hsl(var(--accent-purple))' }} /> AI Configuration
                </h3>
                <p style={{ fontSize: '0.9rem', color: 'hsl(var(--text-muted))' }}>
                  Set your Google Gemini API key to enable autonomous test planning and unhandled visual bug diagnostics.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Gemini API Key</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input 
                      type="password" 
                      placeholder="AIzaSy..." 
                      value={geminiApiKey} 
                      onChange={(e) => setGeminiApiKey(e.target.value)} 
                      style={{ flex: 1 }}
                    />
                    <button onClick={handleSaveApiKey} className="btn btn-primary">Save Key</button>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>
                    Note: For convenience, you can also store this directly in the backend <code style={{ fontFamily: 'var(--font-mono)' }}>.env</code> file under the variable <code style={{ fontFamily: 'var(--font-mono)' }}>GEMINI_API_KEY</code>.
                  </span>
                </div>
              </div>
            )}
          </>
        )}

      </main>

      {/* Create Project Modal */}
      {showAddModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <form onSubmit={handleCreateProject} className="glass-card" style={{ width: '400px', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.25rem' }}>Create New Project</h3>
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
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button type="button" onClick={() => setShowAddModal(false)} className="btn btn-secondary">
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
