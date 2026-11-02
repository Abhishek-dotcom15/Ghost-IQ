import { useState } from 'react';
import { KeyRound, LogIn } from 'lucide-react';
import { loginWithToken, type Me } from '../lib/auth';

interface LoginViewProps {
  me: Me;
  onSignedIn: () => void;
}

/** Shown when sign-in is on and the visitor is anonymous with nothing public to see. */
export default function LoginView({ me, onSignedIn }: LoginViewProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginWithToken(token);
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        className="glass-card"
        style={{
          width: '100%',
          maxWidth: 420,
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '2rem' }} aria-hidden>
            👻
          </span>
          <div>
            <h1 style={{ fontFamily: 'var(--font-title)', fontSize: '1.4rem' }}>
              Sign in to GhostIQ
            </h1>
            <p style={{ fontSize: '0.8rem', color: 'hsl(var(--text-muted))' }}>
              This server requires an account.
            </p>
          </div>
        </div>

        {me.signIn.github && (
          <a
            href="/auth/github"
            className="btn btn-primary"
            style={{ justifyContent: 'center', textDecoration: 'none' }}
          >
            <LogIn size={16} /> Continue with GitHub
          </a>
        )}

        {me.signIn.adminToken && (
          <form
            onSubmit={submit}
            style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
          >
            <label
              htmlFor="admin-token"
              style={{ fontSize: '0.8rem', color: 'hsl(var(--text-muted))' }}
            >
              {me.signIn.github ? 'Or, administrators:' : 'Administrator token'}
            </label>
            <input
              id="admin-token"
              type="password"
              autoComplete="current-password"
              placeholder="GHOSTIQ_ADMIN_TOKEN"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
            <button type="submit" className="btn btn-secondary" disabled={busy || !token}>
              <KeyRound size={14} /> Sign in with admin token
            </button>
          </form>
        )}
        {error && (
          <p role="alert" style={{ color: 'hsl(var(--danger))', fontSize: '0.85rem' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
