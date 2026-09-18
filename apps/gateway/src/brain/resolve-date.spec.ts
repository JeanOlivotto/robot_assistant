import { describe, expect, it } from 'vitest';
import { parseHora, resolveWhen } from './resolve-date.js';

const TZ = 'America/Sao_Paulo';
// sexta-feira, 18/09/2026, 10:00 em São Paulo
const NOW = new Date('2026-09-18T10:00:00-03:00');
const iso = (s: string) => new Date(`${s}-03:00`).toISOString();

function ok(dia: string, hora: string, data?: string): string {
  const r = resolveWhen(dia, data, hora, NOW, TZ);
  if (!r.ok) throw new Error(r.error);
  return r.start.toISOString();
}

describe('resolveWhen', () => {
  it('hoje, amanhã e depois de amanhã', () => {
    expect(ok('hoje', '14:00')).toBe(iso('2026-09-18T14:00:00'));
    expect(ok('amanhã', '9h30')).toBe(iso('2026-09-19T09:30:00'));
    expect(ok('depois de amanhã', '8')).toBe(iso('2026-09-20T08:00:00'));
  });

  it('dia da semana vai para a próxima ocorrência', () => {
    expect(ok('quinta', '14:00')).toBe(iso('2026-09-24T14:00:00'));
    expect(ok('segunda-feira', '10:00')).toBe(iso('2026-09-21T10:00:00'));
    expect(ok('terça', '10:00')).toBe(iso('2026-09-22T10:00:00'));
  });

  it('o mesmo dia da semana: hoje se ainda não passou, senão semana que vem', () => {
    expect(ok('sexta', '15:00')).toBe(iso('2026-09-18T15:00:00'));
    expect(ok('sexta', '09:00')).toBe(iso('2026-09-25T09:00:00'));
  });

  it('data explícita, virando o ano quando já passou', () => {
    expect(ok('data', '14:00', '01/10')).toBe(iso('2026-10-01T14:00:00'));
    expect(ok('data', '14:00', '05/01')).toBe(iso('2027-01-05T14:00:00'));
    expect(ok('data', '14:00', '31/12/2026')).toBe(iso('2026-12-31T14:00:00'));
    expect(ok('data', '09:00', '2026-09-25')).toBe(iso('2026-09-25T09:00:00')); // formato que o gemma manda
  });

  it('vira o mês corretamente', () => {
    const r = resolveWhen('amanha', undefined, '10:00', new Date('2026-09-30T12:00:00-03:00'), TZ);
    expect(r.ok && r.start.toISOString()).toBe(iso('2026-10-01T10:00:00'));
  });

  it('recusa data inexistente, hora inválida e horário que já passou', () => {
    expect(resolveWhen('data', '30/02', '10:00', NOW, TZ).ok).toBe(false);
    expect(resolveWhen('hoje', undefined, '25:00', NOW, TZ).ok).toBe(false);
    expect(resolveWhen('hoje', undefined, '08:00', NOW, TZ).ok).toBe(false);
    expect(resolveWhen('ontem', undefined, '08:00', NOW, TZ).ok).toBe(false);
  });
});

describe('parseHora', () => {
  it('aceita os jeitos comuns de falar hora', () => {
    expect(parseHora('14:00')).toEqual({ h: 14, m: 0 });
    expect(parseHora('14h')).toEqual({ h: 14, m: 0 });
    expect(parseHora('14h30')).toEqual({ h: 14, m: 30 });
    expect(parseHora('9')).toEqual({ h: 9, m: 0 });
    expect(parseHora('meio-dia')).toBeNull();
  });
});
