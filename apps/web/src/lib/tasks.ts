/** Pendências sem hora marcada: o que ficou de ser feito e o robô cobra. */

export interface Task {
  id: string;
  texto: string;
  pessoa?: string;
  origem: 'ata' | 'conversa' | 'manual';
  meetingId?: string;
  createdAt: number;
  doneAt?: number;
  nudges: number;
  lastNudgeAt: number;
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/tasks${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const listTasks = (token: string) => api<Task[]>(token, '');
export const addTask = (token: string, texto: string) =>
  api<Task>(token, '', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto }) });
export const doneTask = (token: string, id: string) => api<Task>(token, `/${id}/done`, { method: 'POST' });
export const dropTask = (token: string, id: string) => api<{ ok: true }>(token, `/${id}/drop`, { method: 'POST' });
