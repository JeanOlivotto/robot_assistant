const TZ = 'America/Sao_Paulo';

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TZ });
const keyFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });

export const hhmm = (ms: number) => timeFmt.format(ms);

/** Chave do dia no fuso do robô (YYYY-MM-DD). */
export const dayKey = (ms: number) => keyFmt.format(ms);

/** "Hoje", "Amanhã", "Ontem" ou "qui., 24/09". */
export function dayLabel(ms: number, now = Date.now()): string {
  const k = dayKey(ms);
  if (k === dayKey(now)) return 'Hoje';
  if (k === dayKey(now + 86_400_000)) return 'Amanhã';
  if (k === dayKey(now - 86_400_000)) return 'Ontem';
  const s = dayFmt.format(ms);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "agora", "há 5 min", "há 2 h". */
export function ago(ms: number, now = Date.now()): string {
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return `há ${h} h`;
}
