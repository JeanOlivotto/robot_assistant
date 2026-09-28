/** O WhatsApp do dono: pareamento pelo QR e a chave de privacidade. */

export type EstadoWhatsapp = 'desligado' | 'aguardando_qr' | 'conectando' | 'conectado';

export interface StatusWhatsapp {
  estado: EstadoWhatsapp;
  /** QR em data URL, enquanto espera você ler no celular. */
  qr: string | null;
  numero: string | null;
  privado: boolean;
  /** Até quando (epoch ms); -1 = até você pedir para voltar. */
  privadoAte: number;
  /** Quantas mensagens recentes ele tem guardadas na memória (para quando você pedir). */
  guardadas: number;
  /** Quantos contatos da agenda do celular ele conhece (é por eles que acha "manda pra Jaque"). */
  contatos: number;
  /** Responde (só conversando) quem chama o Miro pelo nome numa conversa privada. */
  atender: boolean;
  /** A última vez que alguém chamou o Miro no WhatsApp, e o que ele fez (para saber por que não respondeu). */
  ultimoChamado?: { em: number; quem: string; resultado: string } | null;
}

async function api(token: string, path: string, init: RequestInit = {}): Promise<StatusWhatsapp> {
  const res = await fetch(`/api/whatsapp${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  return (await res.json()) as StatusWhatsapp;
}

export const statusWhatsapp = (token: string) => api(token, '');
export const conectarWhatsapp = (token: string) => api(token, '/conectar', { method: 'POST' });
export const desconectarWhatsapp = (token: string) => api(token, '/desconectar', { method: 'POST' });
export const atenderWhatsapp = (token: string, ligar: boolean) =>
  api(token, '/atender', { method: 'POST', body: JSON.stringify({ ligar }) });
export const privacidadeWhatsapp = (token: string, ligar: boolean) =>
  api(token, '/privacidade', { method: 'POST', body: JSON.stringify({ ligar }) });
