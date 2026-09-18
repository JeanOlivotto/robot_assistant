import { useEffect, useRef, useState } from 'react';
import { ago } from '../lib/format';
import {
  MeetingRecorder,
  listMeetings,
  meetingStatus,
  sendSegment,
  startMeeting,
  stopMeeting,
  type Ata,
  type Meeting,
} from '../lib/meeting';

type Phase = 'checking' | 'unavailable' | 'idle' | 'recording' | 'finalizing' | 'done';

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function AtaCard({ ata, titulo }: { ata: Ata; titulo: string }) {
  const copy = () => {
    const linhas = [
      `Ata — ${titulo}`,
      '',
      'Resumo:',
      ata.resumo,
      '',
      ...(ata.decisoes.length ? ['Decisões:', ...ata.decisoes.map((d) => `- ${d}`), ''] : []),
      ...(ata.acoes.length ? ['Ações:', ...ata.acoes.map((a) => `- ${a.texto}${a.responsavel ? ` (${a.responsavel})` : ''}`)] : []),
    ];
    void navigator.clipboard?.writeText(linhas.join('\n'));
  };
  return (
    <div className="ata">
      <div className="ata__head">
        <h3>{titulo}</h3>
        <button type="button" className="mini-btn" onClick={copy}>
          Copiar
        </button>
      </div>
      <p className="ata__resumo">{ata.resumo}</p>
      {ata.decisoes.length > 0 && (
        <>
          <h4>Decisões</h4>
          <ul>
            {ata.decisoes.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </>
      )}
      {ata.acoes.length > 0 && (
        <>
          <h4>Ações</h4>
          <ul>
            {ata.acoes.map((a, i) => (
              <li key={i}>
                {a.texto}
                {a.responsavel && <span className="ata__resp"> — {a.responsavel}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {ata.decisoes.length === 0 && ata.acoes.length === 0 && <p className="hint">Sem decisões ou ações claras nesta reunião.</p>}
    </div>
  );
}

export function MeetingView({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [titulo, setTitulo] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [sent, setSent] = useState(0);
  const [pending, setPending] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Meeting | null>(null);
  const [past, setPast] = useState<Meeting[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const recorder = useRef<MeetingRecorder | null>(null);
  const meetingId = useRef<string | null>(null);
  const queue = useRef<Blob[]>([]);
  const uploading = useRef(false);
  const startedAt = useRef(0);

  useEffect(() => {
    let alive = true;
    meetingStatus(token)
      .then((s) => alive && setPhase(s.ready ? 'idle' : 'unavailable'))
      .catch(() => alive && setPhase('unavailable'));
    listMeetings(token)
      .then((m) => alive && setPast(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
      setLevel(recorder.current?.level() ?? 0);
    }, 200);
    return () => clearInterval(id);
  }, [phase]);

  const pump = async () => {
    if (uploading.current) return;
    uploading.current = true;
    while (queue.current.length) {
      const blob = queue.current.shift()!;
      setPending(queue.current.length);
      try {
        await sendSegment(token, meetingId.current!, blob);
        setSent((s) => s + 1);
      } catch (e) {
        setError(`Falha ao enviar um trecho: ${(e as Error).message}`);
      }
    }
    uploading.current = false;
  };

  const begin = async () => {
    setError('');
    setResult(null);
    setSent(0);
    setPending(0);
    setElapsed(0);
    queue.current = [];
    try {
      const m = await startMeeting(token, titulo);
      meetingId.current = m.id;
      startedAt.current = Date.now();
      const rec = new MeetingRecorder((blob) => {
        queue.current.push(blob);
        setPending(queue.current.length);
        void pump();
      });
      await rec.start();
      recorder.current = rec;
      setPhase('recording');
    } catch (e) {
      setError(`Não consegui iniciar: ${(e as Error).message}`);
    }
  };

  const finish = async () => {
    setPhase('finalizing');
    await recorder.current?.stop(); // resolve só depois de entregar o último trecho
    recorder.current = null;
    await pump(); // envia o que sobrou na fila
    try {
      const m = await stopMeeting(token, meetingId.current!);
      setResult(m);
      setPhase('done');
      listMeetings(token)
        .then(setPast)
        .catch(() => {});
    } catch (e) {
      setError(`Falha ao gerar a ata: ${(e as Error).message}`);
      setPhase('idle');
    }
  };

  const cancel = () => {
    recorder.current?.stop();
    recorder.current = null;
    queue.current = [];
    meetingId.current = null;
    setPhase('idle');
  };

  if (phase === 'checking') return <div className="meeting"><p className="hint">Carregando…</p></div>;

  if (phase === 'unavailable')
    return (
      <div className="meeting">
        <p className="hint">O modo reunião precisa da transcrição (STT) e do cérebro (LLM) ligados no servidor. Fale com quem cuida do robô.</p>
      </div>
    );

  return (
    <div className="meeting">
      {error && (
        <div className="notice" role="status" onClick={() => setError('')}>
          {error}
        </div>
      )}

      {phase === 'idle' && (
        <div className="meeting__start">
          <input
            className="meeting__title"
            placeholder="Nome da reunião (opcional)"
            value={titulo}
            maxLength={120}
            onChange={(e) => setTitulo(e.target.value)}
          />
          {!MeetingRecorder.supported ? (
            <p className="hint">Este navegador não grava áudio.</p>
          ) : (
            <button type="button" className="rec-btn" onClick={begin}>
              <span className="rec-dot" /> Iniciar reunião
            </button>
          )}
          <p className="hint">Deixe o celular perto de quem fala. A ata sai quando você encerrar.</p>
        </div>
      )}

      {phase === 'recording' && (
        <div className="meeting__live">
          <div className="meeting__timer">
            <span className="rec-dot rec-dot--live" />
            {mmss(elapsed)}
          </div>
          <div className="meeting__meter" aria-hidden="true">
            <span style={{ transform: `scaleX(${0.1 + level * 0.9})` }} />
          </div>
          <p className="hint">
            Trechos enviados: {sent}
            {pending > 0 ? ` · ${pending} na fila` : ''}
          </p>
          <button type="button" className="rec-btn rec-btn--stop" onClick={finish}>
            Encerrar e gerar ata
          </button>
          <button type="button" className="mini-btn" onClick={cancel}>
            Descartar
          </button>
        </div>
      )}

      {phase === 'finalizing' && (
        <div className="meeting__live">
          <p className="hint">Gerando a ata… {pending > 0 ? `(enviando ${pending} trecho(s))` : ''}</p>
          <div className="spinner" />
        </div>
      )}

      {phase === 'done' && result?.ata && (
        <div className="meeting__done">
          <AtaCard ata={result.ata} titulo={result.titulo} />
          <button type="button" className="rec-btn" onClick={() => setPhase('idle')}>
            Nova reunião
          </button>
        </div>
      )}

      {(phase === 'idle' || phase === 'done') && past.length > 0 && (
        <div className="meeting__past">
          <h4>Reuniões anteriores</h4>
          {past.map((m) => (
            <div key={m.id} className="meeting__item">
              <button type="button" className="meeting__item-head" onClick={() => setOpen(open === m.id ? null : m.id)}>
                <span>{m.titulo}</span>
                <span className="hint">{ago(m.startedAt, Date.now())}</span>
              </button>
              {open === m.id && m.ata && <AtaCard ata={m.ata} titulo={m.titulo} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
