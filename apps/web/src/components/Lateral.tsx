import { useEffect, useState } from 'react';
import type { AgendaItem } from '@robo/protocol';
import { dayKey, hhmm } from '../lib/format';
import { lerEstado, lerGrafo, type EstadoDoMiro, type Grafo } from '../lib/memoria';
import { doneTask, listTasks, type Task } from '../lib/tasks';

/** "em 25 min", "em 2 h", "agora". */
function falta(ms: number, now: number): string {
  const min = Math.round((ms - now) / 60_000);
  if (min <= 0) return 'agora';
  if (min < 60) return `em ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `em ${h} h${m ? ` ${m}` : ''}`;
}

/** A coluna da direita do painel no computador: o dia de hoje, o que está pendente e o que ele lembra. */
export function Lateral({
  token,
  agenda,
  now,
  onAbrir,
}: {
  token: string;
  agenda: AgendaItem[];
  now: number;
  onAbrir(tab: 'agenda' | 'pendencias' | 'memoria'): void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [grafo, setGrafo] = useState<Grafo | null>(null);
  const [estado, setEstado] = useState<EstadoDoMiro | null>(null);

  const recarregar = () => {
    listTasks(token).then(setTasks).catch(() => undefined);
    lerGrafo(token).then(setGrafo).catch(() => undefined);
    lerEstado(token).then(setEstado).catch(() => undefined);
  };

  // O Miro conclui e anota pendência pela conversa: a lista acompanha sem precisar abrir a aba.
  useEffect(() => {
    recarregar();
    const id = setInterval(recarregar, 30_000);
    return () => clearInterval(id);
  }, [token]);

  const hoje = agenda.filter((i) => i.end > now && dayKey(Math.max(i.start, now)) === dayKey(now));
  const proximo = hoje.find((i) => !i.all_day);
  const abertas = tasks.filter((t) => !t.doneAt);
  const lembra = [...(grafo?.entidades ?? [])].sort((a, b) => b.mentions - a.mentions || b.lastSeenAt - a.lastSeenAt).slice(0, 10);
  const ontem = estado?.diario.find((d) => d.startsWith('ontem'));

  return (
    <aside className="lateral">
      <section className="card card--hoje">
        <header className="card__topo">
          <h3>Hoje</h3>
          <button type="button" className="link-btn" onClick={() => onAbrir('agenda')}>
            agenda
          </button>
        </header>
        {proximo && (
          <div className="proximo">
            <span className="proximo__falta">{falta(proximo.start, now)}</span>
            <strong>{proximo.title}</strong>
            <span className="dim">
              {hhmm(proximo.start)} – {hhmm(proximo.end)}
            </span>
          </div>
        )}
        {hoje.length ? (
          <ul className="linha-tempo">
            {hoje
              .filter((i) => i !== proximo)
              .map((i) => (
                <li key={i.id} className={i.start <= now ? 'linha-tempo--agora' : ''}>
                  <span>{i.all_day ? 'dia todo' : i.start <= now ? 'agora' : hhmm(i.start)}</span>
                  {i.title}
                </li>
              ))}
          </ul>
        ) : (
          <p className="dim">Agenda livre pelo resto do dia.</p>
        )}
      </section>

      <section className="card">
        <header className="card__topo">
          <h3>
            Pendências {abertas.length > 0 && <span className="contador">{abertas.length}</span>}
          </h3>
          <button type="button" className="link-btn" onClick={() => onAbrir('pendencias')}>
            todas
          </button>
        </header>
        {abertas.length ? (
          <ul className="pend">
            {abertas.slice(0, 6).map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="tasks__check"
                  aria-label={`Marcar "${t.texto}" como feita`}
                  onClick={() => void doneTask(token, t.id).then(recarregar)}
                />
                <span>
                  {t.texto}
                  {t.pessoa && <em> · {t.pessoa}</em>}
                </span>
              </li>
            ))}
            {abertas.length > 6 && <li className="dim">+ {abertas.length - 6} na lista</li>}
          </ul>
        ) : (
          <p className="dim">Lista zerada. Respeito.</p>
        )}
      </section>

      <section className="card">
        <header className="card__topo">
          <h3>Ele lembra</h3>
          <button type="button" className="link-btn" onClick={() => onAbrir('memoria')}>
            mapa
          </button>
        </header>
        {ontem && <p className="lateral__diario">{ontem.replace(/^ontem \([^)]*\): /, '')}</p>}
        {lembra.length ? (
          <div className="lembra">
            {lembra.map((e) => (
              <button key={e.id} type="button" className={`chip chip--tipo tipo--${e.tipo}`} onClick={() => onAbrir('memoria')}>
                <i aria-hidden="true" />
                {e.nome}
              </button>
            ))}
          </div>
        ) : (
          <p className="dim">Ainda nada — conversa com ele que vai aparecendo.</p>
        )}
      </section>
    </aside>
  );
}
