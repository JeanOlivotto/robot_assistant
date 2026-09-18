/**
 * Regra FECHADA do doc (seção 10): o LLM nunca calcula data. Ele devolve o dia do jeito
 * que o dono falou ("quinta", "amanhã", "10/10") e a hora; o código resolve no fuso.
 */
import { TZDate } from '@date-fns/tz';

export const DIAS = [
  'hoje',
  'amanha',
  'depois_de_amanha',
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado',
  'domingo',
  'data',
] as const;

const WEEKDAY: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

export type ResolveResult = { ok: true; start: Date } | { ok: false; error: string };

/** "25/09", "25/09/2026", "25/09/26" ou ISO "2026-09-25" (alguns modelos mandam assim). */
function parseData(data: string | undefined): { d: number; m: number; y: number | null } | null {
  const s = (data ?? '').trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]) - 1, d: Number(iso[3]) };
  const br = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(s);
  if (!br) return null;
  const y = br[3] ? (br[3].length === 2 ? 2000 + Number(br[3]) : Number(br[3])) : null;
  return { d: Number(br[1]), m: Number(br[2]) - 1, y };
}

/** "terça-feira" → "terca", "Depois de amanhã" → "depois_de_amanha" */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/-feira$/, '')
    .trim()
    .replace(/\s+/g, '_');
}

/** Aceita "14:00", "14h", "14h30", "9", "09:05". */
export function parseHora(hora: string): { h: number; m: number } | null {
  const m = /^\s*(\d{1,2})\s*(?:[:h]\s*(\d{2})?)?\s*(?:h|hs|horas)?\s*$/i.exec(hora);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** Meia-noite (no fuso) do dia pedido — para consultas, então aceita dias passados. */
export function resolveDay(
  periodo: 'hoje' | 'amanha' | 'data',
  data: string | undefined,
  now: Date,
  tz: string,
): { ok: true; day: Date } | { ok: false; error: string } {
  const today = new TZDate(now.getTime(), tz);
  const midnight = (yy: number, mm: number, dd: number) => new Date(new TZDate(yy, mm, dd, 0, 0, 0, tz).getTime());
  if (periodo === 'hoje') return { ok: true, day: midnight(today.getFullYear(), today.getMonth(), today.getDate()) };
  if (periodo === 'amanha') return { ok: true, day: midnight(today.getFullYear(), today.getMonth(), today.getDate() + 1) };
  const p = parseData(data);
  if (!p) return { ok: false, error: `data inválida "${data ?? ''}" — use DD/MM` };
  return { ok: true, day: midnight(p.y ?? today.getFullYear(), p.m, p.d) };
}

export function resolveWhen(dia: string, data: string | undefined, hora: string, now: Date, tz: string): ResolveResult {
  const t = parseHora(hora);
  if (!t) return { ok: false, error: `hora inválida "${hora}" — use HH:MM` };

  const today = new TZDate(now.getTime(), tz);
  const y = today.getFullYear();
  const mo = today.getMonth();
  const d = today.getDate();
  const at = (yy: number, mm: number, dd: number) => new Date(new TZDate(yy, mm, dd, t.h, t.m, 0, tz).getTime());

  const key = normalize(dia);
  let start: Date;

  if (key === 'hoje') {
    start = at(y, mo, d);
  } else if (key === 'amanha') {
    start = at(y, mo, d + 1);
  } else if (key === 'depois_de_amanha') {
    start = at(y, mo, d + 2);
  } else if (key in WEEKDAY) {
    const diff = (WEEKDAY[key]! - today.getDay() + 7) % 7;
    start = at(y, mo, d + diff);
    // "sexta" dito numa sexta depois do horário = sexta que vem
    if (start.getTime() <= now.getTime()) start = at(y, mo, d + diff + 7);
  } else if (key === 'data') {
    const p = parseData(data);
    if (!p) return { ok: false, error: `data inválida "${data ?? ''}" — use DD/MM` };
    const dd = p.d;
    const mm = p.m;
    const yearGiven = p.y;
    let yy = yearGiven ?? y;
    start = at(yy, mm, dd);
    // sem ano e já passou: é do ano que vem
    if (yearGiven === null && start.getTime() < now.getTime() - 24 * 3600_000) {
      yy += 1;
      start = at(yy, mm, dd);
    }
    const check = new TZDate(start.getTime(), tz);
    if (check.getDate() !== dd || check.getMonth() !== mm) return { ok: false, error: `a data ${data} não existe` };
  } else {
    return { ok: false, error: `dia "${dia}" não reconhecido` };
  }

  if (start.getTime() < now.getTime() - 5 * 60_000) {
    return { ok: false, error: 'esse horário já passou — pergunte ao dono se é outro dia' };
  }
  return { ok: true, start };
}
