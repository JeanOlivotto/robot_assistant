import { useEffect, useRef, useState } from 'react';
import { ago } from '../lib/format';
import { DESKTOP } from '../lib/desktop';
import { addTask } from '../lib/tasks';
import {
  MeetingRecorder,
  agendar,
  apagarMeeting,
  convidar,
  apagarVoz,
  getMeeting,
  listMeetings,
  listarVozes,
  nomearVoz,
  meetingStatus,
  sendSegment,
  startMeeting,
  stopMeeting,
  type Ata,
  type AtaAcao,
  type FonteAudio,
  type Meeting,
  type MeetingFull,
  type VozConhecida,
  type VozReuniao,
} from '../lib/meeting';

type Phase = 'checking' | 'unavailable' | 'idle' | 'recording' | 'finalizing' | 'done';

/**
 * No computador, a gravação acontece no painel e quem mostra que está gravando é a carinha:
 * o painel avisa pelo armazenamento do app, que as duas janelas compartilham.
 */
export const GRAVANDO_KEY = 'robo.gravando';
function marcarGravando(g: { desde: number; titulo: string } | null): void {
  if (!DESKTOP) return;
  try {
    if (g) localStorage.setItem(GRAVANDO_KEY, JSON.stringify(g));
    else localStorage.removeItem(GRAVANDO_KEY);
  } catch {
    /* sem armazenamento: a carinha só não mostra */
  }
}

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

/** Uma tarefa da ata: o texto ocupa a largura toda; quem, prazo e os botões ficam embaixo. */
function Tarefa({ acao, token }: { acao: AtaAcao; token: string }) {
  const [abrindo, setAbrindo] = useState(false);
  const [quando, setQuando] = useState(amanhaCedo);
  const [estado, setEstado] = useState<'' | 'enviando' | 'ok' | 'lembrado' | string>('');

  const confirmar = async (e: React.FormEvent) => {
    e.preventDefault();
    setEstado('enviando');
    try {
      await agendar(token, acao.texto, new Date(quando));
      setEstado('ok');
      setAbrindo(false);
    } catch (err) {
      setEstado((err as Error).message);
    }
  };

  return (
    <li className="tarefa">
      <p className="tarefa__texto">{acao.texto}</p>
      {(acao.responsavel || acao.prazo) && (
        <p className="tarefa__meta">
          {acao.responsavel && <span>👤 {acao.responsavel}</span>}
          {acao.prazo && <span>📅 {acao.prazo}</span>}
        </p>
      )}
      <div className="tarefa__acoes">
        {estado === 'ok' ? (
          <span className="tarefa__ok">✓ na agenda</span>
        ) : estado === 'lembrado' ? (
          <span className="tarefa__ok">✓ nas pendências</span>
        ) : (
          <>
            <button
              type="button"
              className="link-btn"
              title="Sem hora marcada: ele cobra você depois"
              disabled={estado === 'enviando'}
              onClick={() => {
                setEstado('enviando');
                addTask(token, acao.texto)
                  .then(() => setEstado('lembrado'))
                  .catch((e: Error) => setEstado(e.message));
              }}
            >
              Lembrar
            </button>
            <button type="button" className="link-btn" onClick={() => setAbrindo(!abrindo)}>
              {abrindo ? 'Fechar' : 'Agendar'}
            </button>
          </>
        )}
      </div>
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

function mmssDe(seg: number): string {
  return mmss(Math.max(0, Math.round(seg)));
}

/** A reunião inteira, como foi falada — separada por voz quando o servidor conseguiu separar. */
function ReuniaoCompleta({ token, id, vozes }: { token: string; id: string; vozes?: VozReuniao[] }) {
  const [m, setM] = useState<MeetingFull | null>(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    getMeeting(token, id)
      .then(setM)
      .catch((e: Error) => setErro(e.message));
  }, [token, id]);

  if (erro) return <p className="item-ata__erro">Não consegui abrir: {erro}</p>;
  if (!m) return <p className="hint">Carregando a transcrição…</p>;
  if (m.falas?.length) {
    return (
      <div className="transcricao">
        {m.falas.map((f, i) => (
          <div key={i} className="fala">
            <span className={`fala__quem fala__quem--${((f.pessoa - 1) % 6) + 1}`}>
              {vozes?.find((v) => v.pessoa === f.pessoa)?.nome ?? `Pessoa ${f.pessoa}`}{' '}
              <span className="fala__hora">{mmssDe(f.inicio)}</span>
            </span>
            <p>{f.texto}</p>
          </div>
        ))}
      </div>
    );
  }
  return <p className="transcricao transcricao--corrida">{m.transcript || 'Sem transcrição.'}</p>;
}

/** "Quem é a Pessoa 2?" — você diz o nome, a voz entra no banco e a ata passa a usar o nome. */
function QuemEQuem({ token, id, vozes, onNomeada }: { token: string; id: string; vozes: VozReuniao[]; onNomeada(m: MeetingFull): void }) {
  const [nomes, setNomes] = useState<Record<number, string>>({});
  const [salvando, setSalvando] = useState<number | null>(null);
  const [erro, setErro] = useState('');
  const conhecidas = vozes.filter((v) => v.nome);
  const faltam = vozes.filter((v) => !v.nome && v.nomeavel);
  if (!conhecidas.length && !faltam.length) return null;

  const salvar = (pessoa: number) => {
    const nome = (nomes[pessoa] ?? '').trim();
    if (!nome) return;
    setSalvando(pessoa);
    setErro('');
    nomearVoz(token, id, pessoa, nome)
      .then(onNomeada)
      .catch((e: Error) => setErro(e.message))
      .finally(() => setSalvando(null));
  };

  return (
    <div className="quem">
      <h4>Quem falou</h4>
      {conhecidas.length > 0 && (
        <p className="quem__conhecidas">
          {conhecidas.map((v) => (
            <span key={v.pessoa} className="quem__chip">
              ✓ {v.nome}
            </span>
          ))}
        </p>
      )}
      {faltam.map((v) => (
        <form
          key={v.pessoa}
          className="quem__linha"
          onSubmit={(e) => {
            e.preventDefault();
            salvar(v.pessoa);
          }}
        >
          <div className="quem__quem">
            <strong>Pessoa {v.pessoa}</strong>
            {v.amostra && <span className="quem__amostra">“{v.amostra}”</span>}
          </div>
          <div className="quem__campo">
            <input
              placeholder="Quem é?"
              maxLength={40}
              value={nomes[v.pessoa] ?? ''}
              onChange={(e) => setNomes({ ...nomes, [v.pessoa]: e.target.value })}
            />
            <button type="submit" className="mini-btn" disabled={salvando !== null || !(nomes[v.pessoa] ?? '').trim()}>
              {salvando === v.pessoa ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      ))}
      {faltam.length > 0 && <p className="hint">Salvando o nome, eu passo a reconhecer essa voz nas próximas reuniões e no chat.</p>}
      {erro && <span className="item-ata__erro">{erro}</span>}
    </div>
  );
}

function AtaCard({
  ata,
  titulo,
  token,
  id,
  pessoas,
  vozes,
  onAtualizada,
  semCabecalho,
}: {
  ata: Ata;
  titulo: string;
  token: string;
  id: string;
  pessoas?: number;
  vozes?: VozReuniao[];
  /** Você disse quem é uma das vozes: a ata voltou com o nome no lugar de "Pessoa N". */
  onAtualizada?(m: MeetingFull): void;
  /** Em tela cheia o título já está na barra de cima. */
  semCabecalho?: boolean;
}) {
  const [completa, setCompleta] = useState(false);
  const pontos = ata.pontos ?? [];

  const copy = () => {
    const tarefa = (a: AtaAcao) =>
      `- ${a.texto}${[a.responsavel, a.prazo].filter(Boolean).length ? ` (${[a.responsavel, a.prazo].filter(Boolean).join(', ')})` : ''}`;
    const linhas = [
      `Ata — ${titulo}`,
      '',
      'Resumo:',
      ata.resumo,
      '',
      ...(pontos.length ? ['Pontos importantes:', ...pontos.map((p) => `- ${p}`), ''] : []),
      ...(ata.decisoes.length ? ['Decisões:', ...ata.decisoes.map((d) => `- ${d}`), ''] : []),
      ...(ata.acoes.length ? ['Tarefas:', ...ata.acoes.map(tarefa)] : []),
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
      {pessoas ? <p className="ata__meta">{pessoas} voz(es) na reunião</p> : null}
      {vozes?.length ? <QuemEQuem token={token} id={id} vozes={vozes} onNomeada={(m) => onAtualizada?.(m)} /> : null}

      <h4>Resumo</h4>
      <p className="ata__resumo">{ata.resumo}</p>

      {pontos.length > 0 && (
        <>
          <h4>Pontos importantes</h4>
          <ul className="ata__bullets">
            {pontos.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </>
      )}
      {ata.decisoes.length > 0 && (
        <>
          <h4>Decisões</h4>
          <ul className="ata__bullets">
            {ata.decisoes.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </>
      )}
      {ata.acoes.length > 0 && (
        <>
          <h4>Tarefas</h4>
          <ul className="ata__tarefas">
            {ata.acoes.map((a, i) => (
              <Tarefa key={i} acao={a} token={token} />
            ))}
          </ul>
        </>
      )}
      {ata.decisoes.length === 0 && ata.acoes.length === 0 && <p className="hint">Sem decisões ou tarefas claras nesta reunião.</p>}

      <button type="button" className="ata__completa-btn" onClick={() => setCompleta(!completa)}>
        {completa ? 'Esconder a reunião completa' : 'Ver a reunião completa'}
      </button>
      {completa && <ReuniaoCompleta key={JSON.stringify(vozes?.map((v) => v.nome))} token={token} id={id} vozes={vozes} />}
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
  // No app do computador o padrão é o fone + o som do computador (a chamada inteira, sem compartilhar aba).
  const [fonte, setFonte] = useState<FonteAudio>(DESKTOP ? 'computador' : MeetingRecorder.podeGravarAba ? 'aba' : 'mic');
  const [convite, setConvite] = useState('');
  const [copiado, setCopiado] = useState(false);
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
  const [banco, setBanco] = useState<VozConhecida[]>([]);

  const carregarBanco = () => {
    if (guest) return;
    listarVozes(token)
      .then(setBanco)
      .catch(() => {});
  };

  /** Uma voz ganhou nome: troca a reunião em todo lugar onde ela aparece, e o banco muda. */
  const atualizar = (m: MeetingFull) => {
    setResult((r) => (r?.id === m.id ? m : r));
    setCheia((c) => (c?.id === m.id ? m : c));
    setPast((lista) => lista.map((x) => (x.id === m.id ? m : x)));
    carregarBanco();
  };

  const recorder = useRef<MeetingRecorder | null>(null);
  const meetingId = useRef<string | null>(null);
  const queue = useRef<Blob[]>([]);
  const uploading = useRef<Promise<void> | null>(null);
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
      carregarBanco();
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /* A ata sai em segundo plano: enquanto esta tela estiver aberta, confere até ela ficar pronta. */
  const aguardando = phase === 'done' && !guest && result && !result.ata ? result.id : null;
  useEffect(() => {
    if (!aguardando) return;
    const id = setInterval(() => {
      getMeeting(token, aguardando)
        .then((m) => {
          if (!m.ata) return;
          setResult(m);
          listMeetings(token)
            .then(setPast)
            .catch(() => {});
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, [aguardando, token]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
      setLevel(recorder.current?.level() ?? 0);
    }, 200);
    return () => clearInterval(id);
  }, [phase]);

  /*
   * Um envio por vez, e quem chama recebe a MESMA promessa do envio em curso. Antes, o "Encerrar"
   * voltava na hora se um trecho estava subindo, e o fim da reunião chegava depois da ata pronta.
   */
  const pump = (): Promise<void> => {
    if (uploading.current) return uploading.current;
    uploading.current = (async () => {
      while (queue.current.length) {
        const blob = queue.current.shift()!;
        setPending(queue.current.length);
        try {
          await sendWithRetry(blob);
          setSent((s) => s + 1);
        } catch (e) {
          setError(`Falha ao enviar um trecho: ${(e as Error).message}`);
        }
      }
    })().finally(() => {
      uploading.current = null;
    });
    return uploading.current;
  };

  /** A rede do celular pisca: tenta de novo antes de dar o trecho por perdido. */
  const sendWithRetry = async (blob: Blob) => {
    for (let tentativa = 1; ; tentativa++) {
      try {
        return await sendSegment(token, meetingId.current!, blob);
      } catch (e) {
        if (tentativa >= 3) throw e;
        await new Promise((r) => setTimeout(r, 2000 * tentativa));
      }
    }
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
      const rec = new MeetingRecorder(
        (blob) => {
          queue.current.push(blob);
          setPending(queue.current.length);
          void pump();
        },
        // Parou de compartilhar a aba = a chamada acabou: fecha e gera a ata sozinho.
        () => void finishRef.current(),
      );
      await rec.start(fonte);
      recorder.current = rec;
      setPhase('recording');
      marcarGravando({ desde: startedAt.current, titulo: titulo || 'Reunião' });
    } catch (e) {
      setError(`Não consegui iniciar: ${(e as Error).message}`);
    }
  };

  const finish = async () => {
    if (!recorder.current) return; // já encerrando (clicou e a aba também fechou)
    setPhase('finalizing');
    await recorder.current?.stop(); // resolve só depois de entregar o último trecho
    recorder.current = null;
    marcarGravando(null);
    // Envia o que sobrou — inclusive o trecho que chegou no finzinho de um envio em curso.
    while (queue.current.length || uploading.current) await pump();
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

  const finishRef = useRef(finish);
  finishRef.current = finish;

  // "Miro, encerra a reunião" (comando de voz no computador).
  useEffect(() => {
    const encerrar = () => void finishRef.current();
    window.addEventListener('robo:encerrar-reuniao', encerrar);
    return () => window.removeEventListener('robo:encerrar-reuniao', encerrar);
  }, []);

  const cancel = () => {
    recorder.current?.stop();
    recorder.current = null;
    marcarGravando(null);
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
              {!guest && (DESKTOP || MeetingRecorder.podeGravarAba) && (
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
                    className={`chip ${fonte === (DESKTOP ? 'computador' : 'aba') ? 'chip--on' : ''}`}
                    onClick={() => setFonte(DESKTOP ? 'computador' : 'aba')}
                  >
                    {DESKTOP ? 'Reunião online (fone + computador)' : 'Reunião online'}
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
              : fonte === 'computador'
                ? 'Ele grava o seu microfone e tudo o que sai no fone (as outras pessoas da chamada) — Meet, Zoom, Teams, o que for. Pode esconder o painel: a gravação continua, e a carinha mostra que está gravando.'
                : fonte === 'aba'
                ? 'Ao iniciar, escolha a aba do Meet/Zoom e marque "compartilhar áudio da guia" — ele ouve a chamada e o seu microfone. Ao parar de compartilhar, a ata sai sozinha.'
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
              {convite && <p className="hint">Vale 12 horas. Quem abrir grava e a ata vem para você.</p>}
              {convite && (
                <div className="meeting__link-linha">
                  <code className="meeting__link">{convite}</code>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(convite)
                        .then(() => {
                          setCopiado(true);
                          setTimeout(() => setCopiado(false), 2000);
                        })
                        .catch(() => setError('Não consegui copiar — segure o link e copie à mão.'));
                    }}
                  >
                    {copiado ? 'Copiado ✓' : 'Copiar link'}
                  </button>
                </div>
              )}
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

      {phase === 'done' && !guest && result && !result.ata && (
        <div className="meeting__live">
          <div className="spinner" />
          <p className="hint">
            Reunião encerrada. Estou separando as vozes e montando a ata — pode sair desta tela, eu aviso no chat
            quando ficar pronta.
          </p>
          <button type="button" className="rec-btn" onClick={() => setPhase('idle')}>
            Nova reunião
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
          <AtaCard
            ata={result.ata}
            titulo={result.titulo}
            token={token}
            id={result.id}
            pessoas={result.pessoas}
            vozes={result.vozes}
            onAtualizada={atualizar}
          />
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
            <AtaCard
              ata={cheia.ata}
              titulo={cheia.titulo}
              token={token}
              id={cheia.id}
              pessoas={cheia.pessoas}
              vozes={cheia.vozes}
              onAtualizada={atualizar}
              semCabecalho
            />
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
                <span className="hint">{m.ata ? ago(m.startedAt, Date.now()) : 'gerando a ata…'}</span>
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
                  <AtaCard
                    ata={m.ata}
                    titulo={m.titulo}
                    token={token}
                    id={m.id}
                    pessoas={m.pessoas}
                    vozes={m.vozes}
                    onAtualizada={atualizar}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {!guest && (phase === 'idle' || phase === 'done') && banco.length > 0 && (
        <div className="meeting__past">
          <h4>Vozes que o robô reconhece</h4>
          {banco.map((v) => (
            <div key={v.id} className="voz-conhecida">
              <span>{v.nome}</span>
              <button
                type="button"
                className="mini-btn mini-btn--perigo"
                onClick={() => {
                  if (!confirm(`Apagar a voz de ${v.nome}? O robô deixa de reconhecer essa pessoa.`)) return;
                  void apagarVoz(token, v.id)
                    .then(carregarBanco)
                    .catch((e: Error) => setError(`Não consegui apagar: ${e.message}`));
                }}
              >
                Apagar
              </button>
            </div>
          ))}
          <p className="hint">Só a assinatura da voz fica guardada, nunca o áudio.</p>
        </div>
      )}
    </div>
  );
}
