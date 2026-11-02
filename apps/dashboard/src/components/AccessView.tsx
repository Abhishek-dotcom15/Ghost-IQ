import { useCallback, useEffect, useState } from 'react';
import { Globe, KeyRound, Lock, Trash2, UserPlus } from 'lucide-react';
import type { Project } from '../App';
import {
  HttpError,
  createKey,
  listAudit,
  listKeys,
  listMembers,
  removeMember,
  revokeKey,
  setMember,
  setProjectPublic,
  type ApiKeyView,
  type AuditEntry,
  type Me,
  type MemberView,
} from '../lib/auth';

interface AccessViewProps {
  project: Project & { public?: boolean };
  me: Me;
  refresh: () => void;
}

const muted = { fontSize: '0.8rem', color: 'hsl(var(--text-muted))' } as const;
const title = { fontFamily: 'var(--font-title)', fontSize: '1.05rem' } as const;
const th = { textAlign: 'left', padding: '0.4rem 0.5rem', ...muted, fontWeight: 600 } as const;
const td = {
  padding: '0.45rem 0.5rem',
  fontSize: '0.85rem',
  borderTop: '1px solid var(--border-glass)',
} as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '-');

/** Project owners: API keys for runners and CI, members and roles, visibility, audit log. */
export default function AccessView({ project, me, refresh }: AccessViewProps) {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  const [login, setLogin] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const [k, m, a] = await Promise.all([
        listKeys(project.id),
        listMembers(project.id),
        listAudit(project.id),
      ]);
      setKeys(k);
      setMembers(m);
      setAudit(a);
      setForbidden(false);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.status === 401))
        setForbidden(true);
      else setError((err as Error).message);
    }
  }, [project.id]);

  useEffect(() => {
    setNewKey(null);
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!me.authEnabled) {
    return (
      <div className="glass-card">
        <h3 style={title}>Access control is off</h3>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          This server runs without sign-in (GHOSTIQ_AUTH=off): anyone who can reach it has full
          access, and runners need no key. Keep it on localhost, or turn sign-in on before exposing
          it (docs/SECURITY.md).
        </p>
      </div>
    );
  }
  if (forbidden) {
    return (
      <div className="glass-card">
        <h3 style={title}>Owners only</h3>
        <p style={{ ...muted, marginTop: '0.5rem' }}>
          API keys, members and the audit log are managed by the project's owners.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {error && (
        <div
          role="alert"
          className="glass-card"
          style={{ color: 'hsl(var(--danger))', padding: '0.75rem 1rem' }}
        >
          {error}
        </div>
      )}

      {/* API keys */}
      <section
        className="glass-card"
        style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
      >
        <h3 style={title}>
          <KeyRound size={16} style={{ verticalAlign: '-2px' }} /> API keys
        </h3>
        <p style={muted}>
          For runners (<code>ghostiq agent --api-key …</code>), the CLI and CI (
          <code>GHOSTIQ_API_KEY</code>). A key can start runs and read results in this project only.
          It is shown once: store it as a secret.
        </p>
        {newKey && (
          <div
            className="glass-card"
            style={{ borderColor: 'hsl(var(--warning))', padding: '0.75rem 1rem' }}
          >
            <div style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>
              New key <strong>{newKey.name}</strong>. Copy it now: it will not be shown again.
            </div>
            <code
              className="code-block"
              style={{ display: 'block', userSelect: 'all', wordBreak: 'break-all' }}
            >
              {newKey.key}
            </code>
          </div>
        )}
        <form
          style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const created = await createKey(project.id, keyName.trim());
              setNewKey({ name: created.name, key: created.key });
              setKeyName('');
            });
          }}
        >
          <input
            aria-label="Key name"
            placeholder='Key name, e.g. "GitHub Actions"'
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            required
            maxLength={100}
            style={{ flex: '1 1 220px' }}
          />
          <button type="submit" className="btn btn-primary">
            Create key
          </button>
        </form>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Key</th>
                <th style={th}>Created</th>
                <th style={th}>Last used</th>
                <th style={th}>Status</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 && (
                <tr>
                  <td style={td} colSpan={6}>
                    <span style={muted}>No keys yet.</span>
                  </td>
                </tr>
              )}
              {keys.map((k) => (
                <tr key={k.id}>
                  <td style={td}>{k.name}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{k.prefix}…</td>
                  <td style={td}>{when(k.createdAt)}</td>
                  <td style={td}>{when(k.lastUsedAt)}</td>
                  <td style={td}>
                    {k.revokedAt ? (
                      <span className="badge badge-neutral">revoked</span>
                    ) : (
                      <span className="badge badge-success">active</span>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {!k.revokedAt && (
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                        onClick={() => void act(() => revokeKey(k.id))}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Members */}
      <section
        className="glass-card"
        style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
      >
        <h3 style={title}>
          <UserPlus size={16} style={{ verticalAlign: '-2px' }} /> Members
        </h3>
        <p style={muted}>
          Owners manage keys and members; members run tests and triage; viewers read. People must
          sign in once before they can be added.
        </p>
        <form
          style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await setMember(project.id, login.trim(), role);
              setLogin('');
            });
          }}
        >
          <input
            aria-label="GitHub login"
            placeholder="GitHub login"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            style={{ flex: '1 1 200px' }}
          />
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="viewer">viewer</option>
            <option value="member">member</option>
            <option value="owner">owner</option>
          </select>
          <button type="submit" className="btn btn-primary">
            Add / change role
          </button>
        </form>
        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {members.length === 0 && <li style={muted}>No members (admins can always access).</li>}
          {members.map((m) => (
            <li
              key={m.id}
              style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.9rem' }}
            >
              {m.avatarUrl && (
                <img
                  src={m.avatarUrl}
                  alt=""
                  width={22}
                  height={22}
                  style={{ borderRadius: '50%' }}
                />
              )}
              <span>{m.login}</span>
              <span className="badge badge-neutral">{m.role}</span>
              <button
                className="btn btn-secondary"
                style={{ marginLeft: 'auto', fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
                onClick={() => void act(() => removeMember(project.id, m.login))}
                aria-label={`Remove ${m.login}`}
              >
                <Trash2 size={12} /> Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Visibility */}
      <section
        className="glass-card"
        style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}
      >
        <div style={{ flex: '1 1 300px' }}>
          <h3 style={title}>
            {project.public ? (
              <Globe size={16} style={{ verticalAlign: '-2px' }} />
            ) : (
              <Lock size={16} style={{ verticalAlign: '-2px' }} />
            )}{' '}
            Visibility: {project.public ? 'public (read-only demo)' : 'private'}
          </h3>
          <p style={muted}>
            A public project can be viewed by anyone without signing in, read-only. Use it for a
            demo; never for a real app's findings.
          </p>
        </div>
        <button
          className="btn btn-secondary"
          onClick={() =>
            void act(async () => {
              await setProjectPublic(project.id, !project.public);
              refresh();
            })
          }
        >
          Make {project.public ? 'private' : 'public'}
        </button>
      </section>

      {/* Audit */}
      <section
        className="glass-card"
        style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', overflowX: 'auto' }}
      >
        <h3 style={title}>Audit log</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>When</th>
              <th style={th}>Who</th>
              <th style={th}>Action</th>
              <th style={th}>Details</th>
            </tr>
          </thead>
          <tbody>
            {audit.length === 0 && (
              <tr>
                <td style={td} colSpan={4}>
                  <span style={muted}>Nothing recorded yet.</span>
                </td>
              </tr>
            )}
            {audit.map((a) => (
              <tr key={a.id}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{when(a.createdAt)}</td>
                <td style={td}>{a.actorLabel}</td>
                <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  {a.action}
                </td>
                <td style={{ ...td, ...muted }}>
                  {[a.target, a.metadata ? JSON.stringify(a.metadata) : null]
                    .filter(Boolean)
                    .join(' · ')
                    .slice(0, 160)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
