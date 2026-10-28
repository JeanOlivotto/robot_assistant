import type { Face } from '@robo/protocol';

/** O que o Miro lembra do dono: o grafo da memória, o humor dele e o diário dos últimos dias. */

export type TipoEntidade = 'pessoa' | 'projeto' | 'lugar' | 'saude' | 'meta' | 'hobby' | 'trabalho' | 'outro';

export interface Entidade {
  id: string;
  nome: string;
  tipo: TipoEntidade;
  apelidos: string[];
  mentions: number;
  lastSeenAt: number;
}

export interface Ligacao {
  de: string;
  rel: string;
  para?: string;
  valor?: string;
}

export interface Grafo {
  dono: string;
  entidades: Entidade[];
  relacoes: Ligacao[];
}

export interface EstadoDoMiro {
  humor: { face: Face; descricao: string } | null;
  diario: string[];
}

/** O nó fixo do dono no grafo. */
export const DONO = 'dono';

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/memory${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const lerGrafo = (token: string) => api<Grafo>(token, '/grafo');
export const lerEstado = (token: string) => api<EstadoDoMiro>(token, '');
export const esquecer = (token: string, assunto: string) =>
  api<{ forgotten: string[] }>(token, '/forget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assunto }),
  });

export const NOME_DO_TIPO: Record<TipoEntidade, string> = {
  pessoa: 'Pessoa',
  projeto: 'Projeto',
  lugar: 'Lugar',
  saude: 'Saúde',
  meta: 'Meta',
  hobby: 'Hobby',
  trabalho: 'Trabalho',
  outro: 'Assunto',
};

/** "esposa_de" → "esposa de". */
export const relLegivel = (rel: string) => rel.replace(/_/g, ' ');
