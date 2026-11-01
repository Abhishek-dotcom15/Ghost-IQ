import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, FilePlus2, Play, Save, Trash2, AlertTriangle } from 'lucide-react';
import type { Project } from '../App';
import {
  NEW_PERSONA_TEMPLATE,
  duplicateYaml,
  fetchPersonas,
  validatePersona,
  type PersonaView,
  type ValidationResult,
} from '../lib/personas';

interface PersonaBuilderProps {
  project: Project;
}

const muted = { fontSize: '0.8rem', color: 'hsl(var(--text-muted))' } as const;
const mono = { fontFamily: 'var(--font-mono)', fontSize: '0.8rem' } as const;

const SOURCE_LABEL: Record<PersonaView['source'], string> = {
  builtin: 'Built-in',
  file: 'From file',
  custom: 'Custom',
};

/**
 * Personas are YAML data. Pick one to inspect, duplicate a built-in to customise it, or
 * write a new one; validation and the input preview update as you type.
 */
export default function PersonaBuilder({ project }: PersonaBuilderProps) {
  const [personas, setPersonas] = useState<PersonaView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [yaml, setYaml] = useState('');
  const [mode, setMode] = useState<'view' | 'new' | 'edit'>('view');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const selected = useMemo(
    () => personas.find((p) => p.id === selectedId) ?? null,
    [personas, selectedId],
  );

  const reload = useCallback(async (selectId?: string) => {
    try {
      const list = await fetchPersonas();
      setPersonas(list);
      const target = list.find((p) => p.id === selectId) ?? list[0];
      if (target) {
        setSelectedId(target.id);
        setYaml(target.yaml);
        setMode(target.editable ? 'edit' : 'view');
      }
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live validation, debounced.
  useEffect(() => {
    if (!yaml.trim()) return;
    const timer = setTimeout(() => {
      validatePersona(yaml)
        .then(setValidation)
        .catch(() => setValidation(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [yaml]);

  const select = (p: PersonaView) => {
    setSelectedId(p.id);
    setYaml(p.yaml);
    setMode(p.editable ? 'edit' : 'view');
    setMessage(null);
  };

  const startNew = (source?: PersonaView) => {
    setSelectedId(null);
    setYaml(source ? duplicateYaml(source.yaml, source.id) : NEW_PERSONA_TEMPLATE);
    setMode('new');
    setMessage(null);
  };

  const save = async () => {
    const isNew = mode === 'new';
    const res = await fetch(isNew ? '/api/personas' : `/api/personas/${selectedId}`, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml }),
    });
    const body = await res.json();
    if (!res.ok) {
      setMessage({ tone: 'error', text: body.error ?? `Save failed (HTTP ${res.status})` });
      return;
    }
    setMessage({ tone: 'ok', text: `Saved "${body.name}" (version ${body.version}).` });
    await reload(body.id);
  };

  const remove = async () => {
    if (!selected?.editable) return;
    const res = await fetch(`/api/personas/${selected.id}`, { method: 'DELETE' });
    if (res.status === 204) {
      setMessage({ tone: 'ok', text: `Deleted "${selected.name}".` });
      await reload();
    } else {
      setMessage({ tone: 'error', text: `Delete failed (HTTP ${res.status})` });
    }
  };

  /** Dry run: start a real run of the saved persona against the bundled demo app. */
  const dryRun = async () => {
    if (!selected) return;
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        targetUrl: 'http://localhost:3000',
        personaId: selected.id,
        budgets: { maxSteps: 10 },
        consent: selected.spec.requires_consent ? true : undefined,
      }),
    });
    const body = await res.json();
    setMessage(
      res.ok
        ? { tone: 'ok', text: 'Dry run started against the demo app. Watch it in Test Sessions.' }
        : { tone: 'error', text: body.error ?? `Could not start (HTTP ${res.status})` },
    );
  };

  const readOnly = mode === 'view';
  const dirty = selected ? yaml !== selected.yaml : true;
  const valid = validation?.ok === true;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(220px, 280px) 1fr',
        gap: '1.5rem',
        alignItems: 'start',
      }}
    >
      {/* Persona list */}
      <aside
        className="glass-card"
        style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}
      >
        <button
          className="btn btn-primary"
          onClick={() => startNew()}
          style={{ justifyContent: 'center' }}
        >
          <FilePlus2 size={16} /> New persona
        </button>
        {personas.map((p) => (
          <button
            key={p.id}
            onClick={() => select(p)}
            className={`btn ${p.id === selectedId ? 'btn-primary' : 'btn-secondary'}`}
            style={{ justifyContent: 'space-between', textAlign: 'left' }}
          >
            <span>{p.name}</span>
            <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>{SOURCE_LABEL[p.source]}</span>
          </button>
        ))}
      </aside>

      {/* Editor + preview */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          className="glass-card"
          style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}
          >
            <div>
              <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.2rem' }}>
                {mode === 'new' ? 'New persona' : (selected?.name ?? 'Persona')}
              </h3>
              <p style={muted}>
                {mode === 'new'
                  ? 'Write YAML; it is validated as you type.'
                  : selected?.editable
                    ? `Custom persona, version ${selected.version}.`
                    : `${SOURCE_LABEL[selected?.source ?? 'builtin']} persona (read-only). Duplicate it to customise.`}
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {selected && (
                <button className="btn btn-secondary" onClick={() => startNew(selected)}>
                  <Copy size={14} /> Duplicate
                </button>
              )}
              {!readOnly && (
                <button
                  className="btn btn-primary"
                  onClick={() => void save()}
                  disabled={!valid || (!dirty && mode !== 'new')}
                >
                  <Save size={14} /> {mode === 'new' ? 'Create' : 'Save'}
                </button>
              )}
              {selected?.editable && mode === 'edit' && (
                <button className="btn btn-secondary" onClick={() => void remove()}>
                  <Trash2 size={14} /> Delete
                </button>
              )}
              {selected && mode !== 'new' && (
                <button
                  className="btn btn-secondary"
                  onClick={() => void dryRun()}
                  disabled={!project.agentOnline || dirty}
                  title={
                    !project.agentOnline
                      ? 'Start a runner agent first'
                      : dirty
                        ? 'Save first'
                        : 'Run 10 steps against http://localhost:3000'
                  }
                >
                  <Play size={14} /> Dry run on demo app
                </button>
              )}
            </div>
          </div>

          {message && (
            <p
              style={{
                fontSize: '0.85rem',
                color: message.tone === 'ok' ? 'hsl(var(--success))' : 'hsl(var(--danger))',
              }}
            >
              {message.text}
            </p>
          )}

          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            readOnly={readOnly}
            spellCheck={false}
            rows={22}
            style={{
              ...mono,
              width: '100%',
              lineHeight: 1.5,
              whiteSpace: 'pre',
              opacity: readOnly ? 0.85 : 1,
            }}
            aria-label="Persona YAML"
          />

          {validation && !validation.ok && (
            <div
              style={{
                border: '1px solid hsl(var(--danger))',
                borderRadius: 'var(--radius-sm)',
                padding: '0.75rem',
              }}
            >
              <strong
                style={{
                  display: 'flex',
                  gap: '0.4rem',
                  alignItems: 'center',
                  color: 'hsl(var(--danger))',
                }}
              >
                <AlertTriangle size={16} /> {validation.errors.length} problem
                {validation.errors.length > 1 ? 's' : ''}
              </strong>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem', fontSize: '0.8rem' }}>
                {validation.errors.map((e, i) => (
                  <li key={i}>
                    <code style={mono}>{e.line ? `line ${e.line}` : 'file'}</code>
                    {e.path && (
                      <>
                        {' '}
                        <code style={{ ...mono, color: 'hsl(var(--warning))' }}>{e.path}</code>
                      </>
                    )}
                    : {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {validation?.ok && (
          <div
            className="glass-card"
            style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
          >
            <strong
              style={{
                display: 'flex',
                gap: '0.4rem',
                alignItems: 'center',
                color: 'hsl(var(--success))',
              }}
            >
              <CheckCircle2 size={16} /> Valid persona: preview
            </strong>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr',
                gap: '0.35rem 1rem',
                margin: 0,
                fontSize: '0.85rem',
              }}
            >
              <dt style={muted}>Device</dt>
              <dd style={{ margin: 0 }}>{validation.preview.device}</dd>
              <dt style={muted}>Network</dt>
              <dd style={{ margin: 0 }}>{validation.preview.network}</dd>
              <dt style={muted}>Pacing</dt>
              <dd style={{ margin: 0 }}>
                {validation.preview.pacing.min_ms}-{validation.preview.pacing.max_ms} ms between
                actions
              </dd>
              <dt style={muted}>Behaviors</dt>
              <dd style={{ margin: 0 }}>{validation.preview.behaviors.join(', ') || 'none'}</dd>
              <dt style={muted}>Actions</dt>
              <dd style={{ margin: 0 }}>
                {validation.preview.allowedActions === 'all'
                  ? 'all'
                  : validation.preview.allowedActions.join(', ')}
              </dd>
              <dt style={muted}>Destructive</dt>
              <dd style={{ margin: 0 }}>{validation.preview.destructiveActions}</dd>
              {validation.preview.requiresConsent && (
                <>
                  <dt style={muted}>Consent</dt>
                  <dd style={{ margin: 0 }}>required before each run</dd>
                </>
              )}
            </dl>
            <div>
              <div style={{ ...muted, marginBottom: '0.35rem' }}>
                Sample form values for seed {validation.persona.seed} (same seed, same values):
              </div>
              <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                <tbody>
                  {validation.preview.sampleInputs.map((s, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border-glass)' }}>
                      <td style={{ padding: '0.3rem 0.5rem 0.3rem 0', whiteSpace: 'nowrap' }}>
                        {s.field}
                      </td>
                      <td style={{ padding: '0.3rem 0.5rem', ...muted }}>{s.strategy}</td>
                      <td style={{ padding: '0.3rem 0', ...mono, wordBreak: 'break-all' }}>
                        {s.value === '' ? <em style={muted}>(empty)</em> : s.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
