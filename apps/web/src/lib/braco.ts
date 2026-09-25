/** A aba PC: os computadores ligados ao Miro e as ações que rodam sem pedir aprovação. */

export type Sistema = 'linux' | 'windows' | 'mac';

export interface Maquina {
  nome: string;
  sistema: Sistema;
  ativaEm: number;
}

export interface Acao {
  id: string;
  nome: string;
  descricao: string;
  comando: string;
  sistema: Sistema;
  maquina?: string;
  criadaEm: number;
}

export interface Desligada {
  nome: string;
  sistema: Sistema;
  podeLigar: boolean;
}

export type NovaAcao = Pick<Acao, 'descricao' | 'comando' | 'sistema' | 'maquina'>;

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/braco${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const estadoDoBraco = (token: string) =>
  api<{ maquinas: Maquina[]; desligadas: Desligada[]; roboNaRede: boolean; acoes: Acao[] }>(token, '');
export const ligarMaquina = (token: string, nome: string) =>
  api<{ ok: boolean; texto: string }>(token, `/ligar/${encodeURIComponent(nome)}`, { method: 'POST' });
export const esquecerMaquina = (token: string, nome: string) =>
  api<{ ok: true }>(token, `/maquinas/${encodeURIComponent(nome)}`, { method: 'DELETE' });
export const criarAcao = (token: string, a: NovaAcao) => api<Acao>(token, '/acoes', { method: 'POST', body: JSON.stringify(a) });
export const editarAcao = (token: string, id: string, a: NovaAcao) => api<Acao>(token, `/acoes/${id}`, { method: 'PUT', body: JSON.stringify(a) });
export const apagarAcao = (token: string, id: string) => api<{ ok: true }>(token, `/acoes/${id}`, { method: 'DELETE' });

export const NOME_SISTEMA: Record<Sistema, string> = { linux: 'Linux', windows: 'Windows', mac: 'Mac' };
