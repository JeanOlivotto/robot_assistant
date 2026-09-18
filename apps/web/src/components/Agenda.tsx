import type { AgendaItem } from '@robo/protocol';
import { dayKey, dayLabel, hhmm } from '../lib/format';

export function Agenda({ items }: { items: AgendaItem[] }) {
  const now = Date.now();
  const upcoming = items.filter((i) => i.end > now);

  if (!upcoming.length) {
    return (
      <div className="agenda agenda--empty">
        <p>Nada na agenda nos próximos dias.</p>
        <p className="dim">Peça no chat: “marca reunião com o Fábio quinta às 14h”.</p>
      </div>
    );
  }

  const groups = new Map<string, AgendaItem[]>();
  for (const it of upcoming) {
    const k = dayKey(Math.max(it.start, now));
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }

  return (
    <div className="agenda">
      {[...groups.values()].map((list) => (
        <section key={dayKey(Math.max(list[0]!.start, now))}>
          <h3>{dayLabel(Math.max(list[0]!.start, now))}</h3>
          <ul>
            {list.map((it) => {
              const ongoing = it.start <= now;
              return (
                <li key={it.id} className={ongoing ? 'ongoing' : undefined}>
                  <span className="when">{it.all_day ? 'dia todo' : ongoing ? 'agora' : hhmm(it.start)}</span>
                  <span className="what">
                    {it.title}
                    {!it.all_day && <span className="until">até {hhmm(it.end)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
