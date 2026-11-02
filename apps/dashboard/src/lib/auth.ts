export interface Me {
  authEnabled: boolean;
  principal: 'local' | 'admin_token' | 'user' | 'api_key' | 'anonymous';
  user: {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
    admin: boolean;
  } | null;
  admin: boolean;
  signIn: { github: boolean; adminToken: boolean };
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface MemberView {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: 'owner' | 'member' | 'viewer';
}

export interface AuditEntry {
  id: string;
  action: string;
  actorType: string;
  actorLabel: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

/** Thrown for HTTP errors, with the status so views can explain 401/403. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new HttpError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const fetchMe = async () => json<Me>(await fetch('/api/me'));
export const loginWithToken = async (token: string) =>
  json(await fetch('/auth/token', send('POST', { token })));
export const logout = async () => json(await fetch('/auth/logout', send('POST')));

export const listKeys = async (projectId: string) =>
  json<ApiKeyView[]>(await fetch(`/api/projects/${projectId}/keys`));
export const createKey = async (projectId: string, name: string) =>
  json<{ id: string; name: string; prefix: string; key: string }>(
    await fetch(`/api/projects/${projectId}/keys`, send('POST', { name })),
  );
export const revokeKey = async (id: string) => json(await fetch(`/api/keys/${id}`, send('DELETE')));

export const listMembers = async (projectId: string) =>
  json<MemberView[]>(await fetch(`/api/projects/${projectId}/members`));
export const setMember = async (projectId: string, login: string, role: string) =>
  json(await fetch(`/api/projects/${projectId}/members`, send('PUT', { login, role })));
export const removeMember = async (projectId: string, login: string) =>
  json(
    await fetch(`/api/projects/${projectId}/members/${encodeURIComponent(login)}`, send('DELETE')),
  );

export const setProjectPublic = async (projectId: string, isPublic: boolean) =>
  json(await fetch(`/api/projects/${projectId}`, send('PATCH', { public: isPublic })));

export const listAudit = async (projectId: string) =>
  json<AuditEntry[]>(await fetch(`/api/projects/${projectId}/audit?limit=200`));
