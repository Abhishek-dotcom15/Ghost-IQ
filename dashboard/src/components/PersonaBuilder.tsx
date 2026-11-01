import React from 'react';
import { ShieldCheck, Zap, AlertTriangle, UserCheck, Flame, Ban } from 'lucide-react';

export default function PersonaBuilder() {
  const personas = [
    {
      title: 'Happy Path User',
      description: 'Follows standard application flows systematically. Feeds valid format credentials, behaves predictably, and verifies simple UI transitions.',
      icon: <UserCheck size={28} />,
      color: 'hsl(var(--success))',
      bgColor: 'rgba(17,185,129,0.06)',
      behaviors: [
        { label: 'Form Fill', detail: 'Fills accurate inputs (valid email, complex password)' },
        { label: 'Click Pace', detail: 'Methodical (1.5s delay between clicks to let render settle)' },
        { label: 'Goal focus', detail: 'Strict adherence to requested test instructions' }
      ]
    },
    {
      title: 'Chaotic Explorer',
      description: 'Simulates quick visual explorer behavior. Clicks layout items, hits unreferenced routes, submits partial forms, and looks for race conditions.',
      icon: <Flame size={28} />,
      color: 'hsl(var(--warning))',
      bgColor: 'rgba(245,158,11,0.06)',
      behaviors: [
        { label: 'Form Fill', detail: 'Inputs extremely long strings or unexpected structures' },
        { label: 'Click Pace', detail: 'Aggressive clicking on dynamic toggles' },
        { label: 'Path Explorer', detail: 'Attempts navigation to hidden links or external anchors' }
      ]
    },
    {
      title: 'Form Stress Tester',
      description: 'Targets input sanitation and validator robustness. Deliberately feeds empty form submissions, special characters, and SQL script templates.',
      icon: <Ban size={28} />,
      color: 'hsl(var(--danger))',
      bgColor: 'rgba(244,63,94,0.06)',
      behaviors: [
        { label: 'Form Fill', detail: 'Fills empty, boundary-limit values, or injects mock symbols' },
        { label: 'Click Pace', detail: 'Repeatedly hits submit buttons to trigger double-submit actions' },
        { label: 'Validation Focus', detail: 'Asserts that proper client and server error alerts trigger' }
      ]
    }
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Intro info panel */}
      <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ShieldCheck size={20} style={{ color: 'hsl(var(--accent-purple))' }} /> AI Testing Personas Engine
        </h3>
        <p style={{ fontSize: '0.9rem', color: 'hsl(var(--text-muted))', lineHeight: '1.5' }}>
          GhostIQ does not run linear script files. Instead, it instructs the central LLM engine with specific **Behavior Personas**. The persona affects how the LLM interprets the page DOM tree, decides user inputs, select click rates, and maps failure conditions.
        </p>
      </section>

      {/* Grid of Personas */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
        {personas.map((p, idx) => (
          <div key={idx} className="glass-card glow-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            
            {/* Header */}
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <div style={{
                color: p.color,
                backgroundColor: p.bgColor,
                padding: '0.75rem',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid rgba(255,255,255,0.05)`
              }}>
                {p.icon}
              </div>
              <div>
                <h4 style={{ fontFamily: 'var(--font-title)', fontSize: '1.15rem', fontWeight: 700 }}>{p.title}</h4>
                <span style={{ fontSize: '0.65rem', color: p.color, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.5px' }}>
                  Active Persona Mode
                </span>
              </div>
            </div>

            <p style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', lineHeight: '1.5' }}>
              {p.description}
            </p>

            {/* Behaviors */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'hsl(var(--text-muted))' }}>
                Automated Actions Behavior
              </span>
              {p.behaviors.map((b, bIdx) => (
                <div key={bIdx} style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{b.label}</span>
                  <span style={{ fontSize: '0.75rem', color: 'hsl(var(--text-muted))' }}>{b.detail}</span>
                </div>
              ))}
            </div>

          </div>
        ))}
      </section>

      {/* Dynamic customizable notification */}
      <section className="glass-card" style={{
        background: 'rgba(139, 92, 246, 0.02)',
        border: '1px dashed rgba(139, 92, 246, 0.3)',
        textAlign: 'center',
        padding: '2.5rem'
      }}>
        <Zap size={24} style={{ color: 'hsl(var(--accent-purple))', marginBottom: '0.75rem' }} />
        <h4 style={{ fontFamily: 'var(--font-title)', fontSize: '1.1rem' }}>Want custom testing guidelines?</h4>
        <p style={{ fontSize: '0.85rem', color: 'hsl(var(--text-muted))', marginTop: '0.25rem', marginBottom: '1rem' }}>
          You can inject direct behaviors into the testing goals box on the Overview tab (e.g. "Simulate a user speaking Spanish and look for text leaks").
        </p>
      </section>

    </div>
  );
}
