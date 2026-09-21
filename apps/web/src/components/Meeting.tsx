import { useEffect, useRef, useState } from 'react';
import { ago } from '../lib/format';
import { addTask } from '../lib/tasks';
import {
  MeetingRecorder,
  agendar,
  apagarMeeting,
  convidar,
  listMeetings,
  meetingStatus,
  sendSegment,
  startMeeting,
  stopMeeting,
  type Ata,
  type FonteAudio,
  type Meeting,
} from '../lib/meeting';

type Phase = 'checking' | 'unavailable' | 'idle' | 'recording' | 'finalizing' | 'done';

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "amanhã às 9h" no formato que o <input type="datetime-local"> entende. */
function amanhaCedo(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Uma linha da ata (ação ou decisão) com o botão de jogar para a agenda. */
function ItemAta({ texto, responsavel, token }: { texto: string; responsavel?: string; token: string }) {
  const [abrindo, setAbrindo] = useState(false);
  const [quando, setQuando] = useState(amanhaCedo);
  const [estado, setEstado] = useState<'' | 'enviando' | 'ok' | 'lembrado' | string>('');

  const confirmar = async (e: React.FormEvent) => {
    e.preventDefault();
    setEstado('enviando');
    try {
      await agendar(token, texto, new Date(quando));
      setEstado('ok');
      setAbrindo(false);
    } catch (err) {
      setEstado((err as Error).message);
    }
  };

  return (
    <li className="item-ata">
      <div className="item-ata__linha">
        <span className="item-ata__texto">{texto}</span>
        {estado === 'ok' ? (
          <span className="item-ata__ok">na agenda</span>
        ) : estado === 'lembrado' ? (
          <span className="item-ata__ok">nas pendências</span>
        ) : (
          <span className="item-ata__acoes">
            <button
              type="button"
              className="mini-btn item-ata__btn"
              title="Sem hora marcada: ele cobra você depois"
              onClick={() => {
                setEstado('enviando');
                addTask(token, texto)
                  .then(() => setEstado('lembrado'))
                  .catch((e: Error) => setEstado(e.message));
              }}
            >
              Lembrar
            </button>
            <button type="button" className="mini-btn item-ata__btn" onClick={() => setAbrindo(!abrindo)}>
              {abrindo ? 'Fechar' : 'Agendar'}
            </button>
          </span>
        )}
      </div>
      {responsavel && <span className="item-ata__resp">{responsavel}</span>}
      {abrindo && (
        <form className="item-ata__quando" onSubmit={(e) => void confirmar(e)}>
          <input type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} required />
          <button type="submit" className="rec-btn" disabled={estado === 'enviando'}>
            {estado === 'enviando' ? 'Agendando…' : 'Confirmar'}
          </button>
        </form>
      )}
      {estado && !['ok', 'lembrado', 'enviando'].includes(estado) && <span className="item-ata__erro">{estado}</span>}
    </li>
  );
}

function AtaCard({
  ata,
  titulo,
  token,
  semCabecalho,
}: {
  ata: Ata;
  titulo: string;
  token: string;
  /** Em tela cheia o título já está na barra de cima. */
  semCabecalho?: boolean;
}) {
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
        {!semCabecalho && <h3>{titulo}</h3>}
        <button type="button" className="mini-btn" onClick={copy}>
          Copiar
        </button>
      </div>
      <p className="ata__resumo">{ata.resumo}</p>
      {ata.decisoes.length > 0 && (
        <>
          <h4>Decisões</h4>
          <ul className="ata__lista">
            {ata.decisoes.map((d, i) => (
              <ItemAta key={i} texto={d} token={token} />
            ))}
          </ul>
        </>
      )}
      {ata.acoes.length > 0 && (
        <>
          <h4>Ações</h4>
          <ul className="ata__lista">
            {ata.acoes.map((a, i) => (
              <ItemAta key={i} texto={a.texto} responsavel={a.responsavel} token={token} />
            ))}
          </ul>
        </>
      )}
      {ata.decisoes.length === 0 && ata.acoes.length === 0 && <p className="hint">Sem decisões ou ações claras nesta reunião.</p>}
    </div>
  );
}

export function MeetingView({
  token,
  autoStart,
  onAutoStarted,
  guest,
}: {
  token: string;
  autoStart?: boolean;
  onAutoStarted?(): void;
  /** Modo convidado: grava e entrega, sem ver a ata nem as reuniões anteriores. */
  guest?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('checking');
  /* No computador a reunião é online (áudio da aba); no celular, que não captura aba, é o
     microfone gravando a sala. Quem está no computador ainda pode trocar para a sala no botão. */
  const [fonte, setFonte] = useState<FonteAudio>(MeetingRecorder.podeGravarAba ? 'aba' : 'mic');
  const [convite, setConvite] = useState('');
  /** Ata aberta em tela cheia — em telas pequenas a ata fica espremida no meio da lista. */
  const [cheia, setCheia] = useState<Meeting | null>(null);

  /* Com a tela cheia aberta, o gesto de voltar do celular fecha a ata em vez de sair do app. */
  useEffect(() => {
    if (!cheia) return;
    history.pushState({ ataCheia: true }, '');
    const travado = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // a lista atrás não rola junto
    const voltar = () => setCheia(null);
    const tecla = (e: KeyboardEvent) => e.key === 'Escape' && fecharCheia();
    window.addEventListener('popstate', voltar);
    window.addEventListener('keydown', tecla);
    return () => {
      document.body.style.overflow = travado;
      window.removeEventListener('popstate', voltar);
      window.removeEventListener('keydown', tecla);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cheia]);

  /** Sai pelo history quando foi ele que abriu, para não deixar entrada solta na navegação. */
  const fecharCheia = () => {
    if (window.history.state?.ataCheia) window.history.back();
    else setCheia(null);
  };
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
    if (!guest) {
      listMeetings(token)
        .then((m) => alive && setPast(m))
        .catch(() => {});
    }
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
      await rec.start(fonte);
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
      if (!guest) {
        listMeetings(token)
          .then(setPast)
          .catch(() => {});
      }
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

  // Veio do modo conversa ("iniciar reunião"): começa a gravar assim que estiver pronto.
  useEffect(() => {
    if (autoStart && phase === 'idle') {
      onAutoStarted?.();
      void begin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, phase]);

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
            <>
              {!guest && MeetingRecorder.podeGravarAba && (
                <div className="meeting__fonte">
                  <button
                    type="button"
                    className={`chip ${fonte === 'mic' ? 'chip--on' : ''}`}
                    onClick={() => setFonte('mic')}
                  >
                    Sala (microfone)
                  </button>
                  <button
                    type="button"
                    className={`chip ${fonte === 'aba' ? 'chip--on' : ''}`}
                    onClick={() => setFonte('aba')}
                  >
                    Reunião online
                  </button>
                </div>
              )}
              <button type="button" className="rec-btn" onClick={begin}>
                <span className="rec-dot" /> Iniciar reunião
              </button>
            </>
          )}
          <p className="hint">
            {guest && fonte === 'mic'
              ? 'Este navegador não captura o áudio da aba: ele vai gravar pelo microfone. Para pegar todo mundo da chamada, abra este link no Chrome do computador.'
              : fonte === 'aba'
                ? 'Ao iniciar, escolha a aba do Meet/Zoom e marque "compartilhar áudio da guia" — ele ouve todo mundo da chamada.'
                : 'Deixe o celular perto de quem fala. A ata sai quando você encerrar.'}
          </p>
          {!guest && (
            <div className="meeting__convite">
              <button
                type="button"
                className="mini-btn"
                onClick={() => {
                  void convidar(token, titulo)
                    .then((c) => {
                      setConvite(c.url);
                      void navigator.clipboard?.writeText(c.url);
                    })
                    .catch((e: Error) => setError(`Não consegui criar o link: ${e.message}`));
                }}
              >
                Não vou poder ir: gerar link
              </button>
              {convite && <p className="hint">Link copiado — vale 12 horas. Quem abrir grava e a ata vem para você.</p>}
              {convite && <code className="meeting__link">{convite}</code>}
            </div>
          )}
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

      {phase === 'done' && guest && (
        <div className="meeting__done">
          <p className="ata__resumo">Pronto, entreguei a ata. Pode fechar esta página.</p>
          <button type="button" className="rec-btn" onClick={() => setPhase('idle')}>
            Gravar outra
          </button>
        </div>
      )}

      {phase === 'done' && !guest && result?.ata && (
        <div className="meeting__done">
          <div className="meeting__item-acoes">
            <button type="button" className="mini-btn" onClick={() => setCheia(result)}>
              Abrir em tela cheia
            </button>
          </div>
          <AtaCard ata={result.ata} titulo={result.titulo} token={token} />
          <button type="button" className="rec-btn" onClick={() => setPhase('idle')}>
            Nova reunião
          </button>
        </div>
      )}

      {cheia?.ata && (
        <div className="ata-cheia" role="dialog" aria-label={`Ata: ${cheia.titulo}`}>
          <div className="ata-cheia__topo">
            <button type="button" className="ata-cheia__voltar" onClick={fecharCheia}>
              ‹ Voltar
            </button>
            <span className="ata-cheia__titulo">{cheia.titulo}</span>
          </div>
          <div className="ata-cheia__conteudo">
            <AtaCard ata={cheia.ata} titulo={cheia.titulo} token={token} semCabecalho />
          </div>
        </div>
      )}

      {!guest && (phase === 'idle' || phase === 'done') && past.length > 0 && (
        <div className="meeting__past">
          <h4>Reuniões anteriores</h4>
          {past.map((m) => (
            <div key={m.id} className="meeting__item">
              <button type="button" className="meeting__item-head" onClick={() => setOpen(open === m.id ? null : m.id)}>
                <span>{m.titulo}</span>
                <span className="hint">{ago(m.startedAt, Date.now())}</span>
              </button>
              {open === m.id && m.ata && (
                <>
                  <div className="meeting__item-acoes">
                    <button type="button" className="mini-btn" onClick={() => setCheia(m)}>
                      Abrir em tela cheia
                    </button>
                    <button
                      type="button"
                      className="mini-btn mini-btn--perigo"
                      onClick={() => {
                        if (!confirm(`Apagar "${m.titulo}"? A ata some de vez.`)) return;
                        void apagarMeeting(token, m.id)
                          .then(() => {
                            setOpen(null);
                            setPast((lista) => lista.filter((x) => x.id !== m.id));
                          })
                          .catch((e: Error) => setError(`Não consegui apagar: ${e.message}`));
                      }}
                    >
                      Apagar
                    </button>
                  </div>
                  <AtaCard ata={m.ata} titulo={m.titulo} token={token} />
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
