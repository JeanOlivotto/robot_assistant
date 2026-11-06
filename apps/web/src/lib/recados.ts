/** Recados das aplicações do dono: as aplicações (com as chaves) e os recados abertos. */

export type TipoRecado = 'suporte' | 'saude' | 'cadastro' | 'outro';
export type PrioridadeRecado = 'baixa' | 'normal' | 'urgente';

export interface Recado {
  id: string;
  app: string;
  tipo: TipoRecado;
  prioridade: PrioridadeRecado;
  titulo: string;
  texto: string;
  link?: string;
  atualizadoEm: number;
  vezes: number;
}

export interface AppRecados {
  nome: string;
  /** Começo da chave em uso ("rcd_Ab12"). */
  prefixo: string;
  ativo: boolean;
  criadoEm: number;
  tokenEm: number;
  saudeUrl?: string;
  ultimoRecadoEm?: number;
  recebidos: number;
  abertos: number;
  /** A última sonda do /health (null = sem sonda ainda). */
  saude: { ok: boolean; em: number; erro?: string } | null;
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/recados${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const corpo = await res.text().catch(() => '');
    let msg = corpo;
    try {
      msg = (JSON.parse(corpo) as { message?: string }).message ?? corpo;
    } catch {
      /* texto puro */
    }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const listarApps = (token: string) => api<AppRecados[]>(token, '/apps');
export const criarApp = (token: string, nome: string, saudeUrl: string) =>
  api<{ app: AppRecados; token: string }>(token, '/apps', { method: 'POST', body: JSON.stringify({ nome, saudeUrl }) });
export const mudarApp = (token: string, nome: string, m: { ativo?: boolean; saudeUrl?: string }) =>
  api<AppRecados>(token, `/apps/${encodeURIComponent(nome)}`, { method: 'PATCH', body: JSON.stringify(m) });
export const novaChave = (token: string, nome: string) =>
  api<{ token: string }>(token, `/apps/${encodeURIComponent(nome)}/chave`, { method: 'POST' });
export const apagarApp = (token: string, nome: string) => api<{ ok: true }>(token, `/apps/${encodeURIComponent(nome)}`, { method: 'DELETE' });

export const listarAbertos = (token: string) => api<Recado[]>(token, '');
export const darBaixa = (token: string, id: string) => api<Recado>(token, `/${encodeURIComponent(id)}/baixa`, { method: 'POST' });

/** "Baixa XML" → "baixa-xml": o nome que o servidor aceita. */
export function nomeDeApp(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 31);
}
