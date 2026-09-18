import ical from 'node-ical';
import { describe, expect, it } from 'vitest';
import { deviceText } from './device-text.js';
import { expandCalendar, toAgendaItems } from './occurrences.js';

// Formato igual ao do link iCal secreto do Google Agenda.
const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VTIMEZONE
TZID:America/Sao_Paulo
BEGIN:STANDARD
TZOFFSETFROM:-0300
TZOFFSETTO:-0300
TZNAME:-03
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=America/Sao_Paulo:20260921T140000
DTEND;TZID=America/Sao_Paulo:20260921T150000
UID:unico@google.com
SUMMARY:Reunião com o Fábio 🚀
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/Sao_Paulo:20260914T090000
DTEND;TZID=America/Sao_Paulo:20260914T091500
RRULE:FREQ=DAILY
EXDATE;TZID=America/Sao_Paulo:20260922T090000
UID:daily@google.com
SUMMARY:Daily
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/Sao_Paulo:20260923T100000
DTEND;TZID=America/Sao_Paulo:20260923T101500
RECURRENCE-ID;TZID=America/Sao_Paulo:20260923T090000
UID:daily@google.com
SUMMARY:Daily (remarcada)
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260922
DTEND;VALUE=DATE:20260923
UID:feriado@google.com
SUMMARY:Aniversário da Ana
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/Sao_Paulo:20260921T160000
DTEND;TZID=America/Sao_Paulo:20260921T170000
UID:cancelado@google.com
STATUS:CANCELLED
SUMMARY:Cancelado
END:VEVENT
END:VCALENDAR`;

const local = (iso: string) => new Date(`${iso}-03:00`);

describe('expandCalendar', () => {
  const cal = ical.sync.parseICS(ICS);
  const occ = expandCalendar(cal, local('2026-09-21T00:00:00'), local('2026-09-23T23:59:59'));
  const summary = occ.map((o) => `${o.start.toISOString()} ${o.title}${o.allDay ? ' [dia]' : ''}`);

  it('expande a recorrência respeitando EXDATE e RECURRENCE-ID', () => {
    const daily = occ.filter((o) => o.title.startsWith('Daily'));
    expect(daily.map((o) => o.start.getTime())).toEqual([
      local('2026-09-21T09:00:00').getTime(), // 22 foi excluída (EXDATE)
      local('2026-09-23T10:00:00').getTime(), // 23 remarcada para 10h
    ]);
    expect(daily[1]!.title).toBe('Daily (remarcada)');
  });

  it('inclui evento único, dia inteiro e ignora cancelado', () => {
    expect(summary).toContain(`${local('2026-09-21T14:00:00').toISOString()} Reunião com o Fábio`);
    expect(occ.find((o) => o.title === 'Aniversário da Ana')?.allDay).toBe(true);
    expect(occ.some((o) => o.title === 'Cancelado')).toBe(false);
  });

  it('ordena por início e gera ids estáveis de 16 hex', () => {
    const starts = occ.map((o) => o.start.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const again = expandCalendar(cal, local('2026-09-21T00:00:00'), local('2026-09-23T23:59:59'));
    expect(again.map((o) => o.id)).toEqual(occ.map((o) => o.id));
    expect(toAgendaItems(occ)[0]!.id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('deviceText', () => {
  it('mantém acentos, troca pontuação tipográfica e remove emoji', () => {
    expect(deviceText('Café — “sprint” 🚀  review…', 63)).toBe('Café - "sprint" review...');
  });

  it('corta em bytes UTF-8 sem quebrar caractere', () => {
    expect(deviceText('ããã', 5)).toBe('ãã'); // cada "ã" tem 2 bytes
  });

  it('usa o fallback quando sobra texto vazio', () => {
    expect(deviceText('🎉', 63, '(sem título)')).toBe('(sem título)');
  });
});
