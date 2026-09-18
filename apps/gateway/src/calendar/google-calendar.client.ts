import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { LIMITS } from '@robo/protocol';
import { deviceText } from './device-text.js';
import { occurrenceId, type Occurrence } from './occurrences.js';

interface GDate {
  date?: string; // dia inteiro: YYYY-MM-DD
  dateTime?: string;
}

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  start: GDate;
  end: GDate;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** Google Calendar API v3 com conta de serviço (a agenda precisa estar compartilhada com ela). */
export class GoogleCalendarClient {
  private readonly jwt: JWT;
  private readonly eventsUrl: string;
  readonly serviceAccount: string;

  constructor(keyFile: string, calendarId: string, private readonly tz: string) {
    const creds = JSON.parse(readFileSync(keyFile, 'utf8')) as { client_email: string; private_key: string };
    this.serviceAccount = creds.client_email;
    this.jwt = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });
    this.eventsUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  }

  /** Ocorrências em [from, to] — o Google já expande recorrências (singleEvents). */
  async list(from: Date, to: Date): Promise<Occurrence[]> {
    const out: Occurrence[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.jwt.request<{ items?: GEvent[]; nextPageToken?: string }>({
        url: this.eventsUrl,
        params: {
          singleEvents: true,
          orderBy: 'startTime',
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          maxResults: 250,
          pageToken,
        },
      });
      for (const ev of res.data.items ?? []) {
        const occ = toOccurrence(ev);
        if (occ) out.push(occ);
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return out;
  }

  async insert(title: string, start: Date, end: Date): Promise<{ id: string; htmlLink?: string }> {
    const res = await this.jwt.request<{ id: string; htmlLink?: string }>({
      url: this.eventsUrl,
      method: 'POST',
      data: {
        summary: title,
        start: { dateTime: start.toISOString(), timeZone: this.tz },
        end: { dateTime: end.toISOString(), timeZone: this.tz },
      },
    });
    return res.data;
  }
}

/** Dia inteiro vira meia-noite local (o processo roda com TZ=TZ_NAME, ver load-env.ts). */
function parseGDate(d: GDate): { date: Date; allDay: boolean } | null {
  if (d.dateTime) return { date: new Date(d.dateTime), allDay: false };
  if (d.date) {
    const [y, m, day] = d.date.split('-').map(Number);
    return { date: new Date(y!, m! - 1, day!), allDay: true };
  }
  return null;
}

function toOccurrence(ev: GEvent): Occurrence | null {
  if (ev.status === 'cancelled') return null;
  if (ev.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return null;
  const start = parseGDate(ev.start);
  const end = parseGDate(ev.end);
  if (!start || !end) return null;
  return {
    id: occurrenceId(ev.id, start.date),
    title: deviceText(ev.summary ?? '', LIMITS.TITLE_MAX_BYTES, '(sem título)'),
    start: start.date,
    end: end.date,
    allDay: start.allDay,
  };
}
