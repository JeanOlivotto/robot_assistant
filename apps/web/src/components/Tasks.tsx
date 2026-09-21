import { useEffect, useState } from 'react';
import { addTask, doneTask, dropTask, listTasks, type Task } from '../lib/tasks';

/** O que ficou de ser feito e não tem hora: sai das atas e da conversa, e o robô cobra. */
export function Tasks({ token }: { token: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState('');

  const recarregar = () => {
    listTasks(token)
      .then(setTasks)
      .catch((e: Error) => setErro(e.message));
  };

  useEffect(recarregar, [token]);

  const abertas = tasks.filter((t) => !t.doneAt);
  const feitas = tasks.filter((t) => t.doneAt).slice(0, 5);

  const criar = (e: React.FormEvent) => {
    e.preventDefault();
    const t = texto.trim();
    if (t.length < 3) return;
    setTexto('');
    addTask(token, t)
      .then(recarregar)
      .catch((e: Error) => setErro(e.message));
  };

  return (
    <div className="tasks">
      <form className="tasks__novo" onSubmit={criar}>
        <input
          value={texto}
          maxLength={160}
          placeholder="O que ficou de fazer?"
          onChange={(e) => setTexto(e.target.value)}
        />
        <button type="submit" className="mini-btn" disabled={texto.trim().length < 3}>
          Anotar
        </button>
      </form>
      {erro && <p className="hint">{erro}</p>}

      {!abertas.length && <p className="hint">Nada pendente. O que sair das reuniões aparece aqui.</p>}

      <ul className="tasks__lista">
        {abertas.map((t) => (
          <li key={t.id} className="tasks__item">
            <button
              type="button"
              className="tasks__check"
              aria-label="Marcar como feita"
              onClick={() => void doneTask(token, t.id).then(recarregar)}
            />
            <div className="tasks__texto">
              <span>{t.texto}</span>
              <span className="tasks__meta">
                {t.pessoa && `${t.pessoa} · `}
                {t.origem === 'ata' ? 'da reunião' : t.origem === 'conversa' ? 'da conversa' : 'anotada'}
                {t.nudges > 0 && ` · cobrada ${t.nudges}×`}
              </span>
            </div>
            <button
              type="button"
              className="tasks__drop"
              aria-label="Tirar da lista"
              onClick={() => void dropTask(token, t.id).then(recarregar)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      {feitas.length > 0 && (
        <>
          <h4 className="tasks__titulo">Resolvidas</h4>
          <ul className="tasks__lista tasks__lista--feitas">
            {feitas.map((t) => (
              <li key={t.id} className="tasks__item">
                <span className="tasks__texto">{t.texto}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
