import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}

type Notify = (toast: Omit<Toast, 'id'>) => void;

const ToastContext = createContext<Notify>(() => {});

const TONES = {
  success: { Icon: CheckCircle2, color: 'hsl(var(--success))' },
  error: { Icon: XCircle, color: 'hsl(var(--danger))' },
  warning: { Icon: AlertTriangle, color: 'hsl(var(--warning))' },
  info: { Icon: Info, color: 'hsl(var(--info))' },
} as const;

/** Non-blocking notifications (replaces window.alert). Announced to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const notify = useCallback<Notify>(
    (toast) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-3), { ...toast, id }]);
      setTimeout(() => dismiss(id), toast.tone === 'error' ? 8000 : 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => {
          const { Icon, color } = TONES[t.tone];
          return (
            <div key={t.id} className="toast" role={t.tone === 'error' ? 'alert' : 'status'}>
              <Icon size={18} style={{ color, flexShrink: 0, marginTop: 1 }} aria-hidden />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', flex: 1 }}>
                <strong style={{ fontWeight: 600 }}>{t.title}</strong>
                {t.body && <span style={{ color: 'hsl(var(--text-muted))' }}>{t.body}</span>}
                {t.action && (
                  <button
                    className="btn btn-secondary"
                    style={{
                      alignSelf: 'flex-start',
                      marginTop: '0.4rem',
                      padding: '0.3rem 0.7rem',
                      fontSize: '0.78rem',
                    }}
                    onClick={() => {
                      t.action!.onClick();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="btn-ghost"
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: 'hsl(var(--text-muted))',
                  padding: 2,
                }}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
