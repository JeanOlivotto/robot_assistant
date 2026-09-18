import { createHash } from 'node:crypto';
import ical, { type CalendarResponse, type ParameterValue, type VEvent } from 'node-ical';
import { LIMITS, type AgendaItem } from '@robo/protocol';
import { deviceText } from './device-text.js';

export interface Occurrence {
  /** Id curto e estável da ocorrência (UID + início), cabe no buffer do firmware. */
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
}

function summaryText(s: ParameterValue | undefined): string {
  if (!s) return '';
  return typeof s === 'string' ? s : s.val;
}

export function occurrenceId(uid: string, start: Date): string {
  return createHash('sha1').update(`${uid}|${start.toISOString()}`).digest('hex').slice(0, 16);
}

/** Expande recorrências e devolve as ocorrências que tocam [from, to], ordenadas por início. */
export function expandCalendar(cal: CalendarResponse, from: Date, to: Date): Occurrence[] {
  const out: Occurrence[] = [];

  for (const comp of Object.values(cal)) {
    if (!comp || comp.type !== 'VEVENT') continue;
    const ev = comp as VEvent;
    if (ev.status === 'CANCELLED') continue;

    let instances: ReturnType<typeof ical.expandRecurringEvent>;
    try {
      instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    } catch {
      continue; // um evento malformado não derruba a agenda inteira
    }

    for (const inst of instances) {
      if (inst.event.status === 'CANCELLED') continue;
      out.push({
        id: occurrenceId(ev.uid, inst.start),
        title: deviceText(summaryText(inst.summary), LIMITS.TITLE_MAX_BYTES, '(sem título)'),
        start: inst.start,
        end: inst.end,
        allDay: inst.isFullDay,
      });
    }
  }

  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function toAgendaItems(occ: Occurrence[], limit: number = LIMITS.AGENDA_MAX_ITEMS): AgendaItem[] {
  return occ.slice(0, limit).map((o) => ({
    id: o.id,
    title: o.title,
    start: o.start.getTime(),
    end: o.end.getTime(),
    all_day: o.allDay,
  }));
}
