import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import type { ChatMessage } from '@robo/protocol';
import { desktop } from '../lib/desktop';
import { escutar } from '../lib/escuta';
import { convidar } from '../lib/meeting';
import { GRAVANDO_KEY } from './Meeting';
import { configureSpeech, speak, stopSpeaking } from '../lib/speech';
import { useRobo } from '../lib/useRobo';
import { RobotFace } from './RobotFace';
import { cabecalhosDeOnde, eParaMim } from '../lib/origem';

const TOKEN_KEY = 'robo.token';
const VOZ_KEY = 'robo.desktopVoz';
/** O balão some sozinho depois disso (mais tempo para texto longo), a não ser que o mouse esteja nele. */
const BALAO_MIN_MS = 9000;
const BALAO_POR_LETRA_MS = 45;
/** Balão que você abriu fecha depois deste tempo parado (sem mouse em cima nem digitação). */
const BALAO_PARADO_MS = 30_000;
/** Mexeu mais que isso com o botão apertado: é arrastar, não clicar. */
const ARRASTO_PX = 4;

const TAG: Partial<Record<NonNullable<ChatMessage['kind']>, string>> = {
  reminder: 'lembrete',
  meeting: 'reunião',
};

function lerToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * A carinha flutuante no computador. Mostra o rosto do robô (o mesmo da tela física), abre um
 * balão quando ele fala, e dá para responder ali mesmo. Clique abre o painel com o app inteiro;
 * arrastar move a carinha pela tela.
 */
export function DesktopBubble() {
  const [token, setToken] = useState(lerToken);
  const andando = useAndando();

  // O login acontece no painel (a outra janela): quando ele grava a senha, a bolha acorda.
  // Sem login (app recém-instalado), o painel já abre com a tela de entrar.
  useEffect(() => {
    if (token) return;
    desktop?.painel('abrir');
    const onStorage = () => setToken(lerToken());
    window.addEventListener('storage', onStorage);
    const id = setInterval(onStorage, 3000);
    return () => {
      window.removeEventListener('storage', onStorage);
      clearInterval(id);
    };
  }, [token]);

  if (!token) return <Carinha face={null} andando={andando} onClick={() => desktop?.painel('abrir')} dica="Clique para entrar" />;
  return <BolhaLogada token={token} andando={andando} />;
}

/** O painel está gravando uma reunião? (ele avisa pelo armazenamento que as janelas compartilham) */
function useGravando(): number | null {
  const ler = () => {
    try {
      const g = JSON.parse(localStorage.getItem(GRAVANDO_KEY) ?? 'null') as { desde?: number } | null;
      return g?.desde ?? null;
    } catch {
      return null;
    }
  };
  const [desde, setDesde] = useState(ler);
  const [, tique] = useState(0);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === GRAVANDO_KEY && setDesde(ler());
    window.addEventListener('storage', onStorage);
    const id = setInterval(() => tique((n) => n + 1), 1000); // o relógio anda
    return () => {
      window.removeEventListener('storage', onStorage);
      clearInterval(id);
    };
  }, []);
  return desde;
}

/** O Electron avisa quando a carinha está andando para o monitor em uso, e para que lado. */
function useAndando(): 'esquerda' | 'direita' | null {
  const [lado, setLado] = useState<'esquerda' | 'direita' | null>(null);
  useEffect(() => {
    desktop?.aoAndar?.(setLado);
  }, []);
  return lado;
}

/** O balão aberto: a mensagem (se houver), desde quando aparece e se foi você que abriu. */
interface Balao {
  msg: ChatMessage | null;
  desde: number;
  porClique: boolean;
}

/** Mensagem do robô recente o bastante para aparecer quando você clica na carinha. */
const RECENTE_MS = 30 * 60_000;

function BolhaLogada({ token, andando }: { token: string; andando: 'esquerda' | 'direita' | null }) {
  const robo = useRobo(token);
  const [balao, setBalao] = useState<Balao | null>(null);
  const [resposta, setResposta] = useState('');
  const [esperando, setEsperando] = useState(false);
  const [emCima, setEmCima] = useState(false);
  const [voz, setVoz] = useState(() => {
    try {
      return localStorage.getItem(VOZ_KEY) === '1';
    } catch {
      return false;
    }
  });
  const vistoAte = useRef(Date.now()); // o histórico que já existia não vira balão
  /** Você falou "Miro, …": a próxima resposta sai em voz mesmo com a voz desligada. */
  const falarProxima = useRef(false);
  const [atento, setAtento] = useState(false); // ouviu algo parecido com o nome e está confirmando
  /** O microfone está aberto para o "Miro, …" (null: este app não tem ouvido). */
  const [ouvindo, setOuvindo] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void configureSpeech(token);
    desktop?.bracoToken?.(token); // o braço do app entra no servidor com a mesma senha
  }, [token]);

  // Menu da bandeja também liga/desliga a voz — e ela precisa saber como a voz começou.
  useEffect(() => {
    desktop?.aoMudarVoz((ligada) => {
      setVoz(ligada);
      try {
        localStorage.setItem(VOZ_KEY, ligada ? '1' : '0');
      } catch {
        /* sem armazenamento: vale só agora */
      }
    });
    desktop?.vozMudou(voz);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trocarVoz = () => {
    const nova = !voz;
    setVoz(nova);
    try {
      localStorage.setItem(VOZ_KEY, nova ? '1' : '0');
    } catch {
      /* sem armazenamento: vale só agora */
    }
    desktop?.vozMudou(nova);
    if (!nova) stopSpeaking();
  };

  // Mensagem nova do robô: abre o balão (e fala, se a voz estiver ligada).
  useEffect(() => {
    const todas = robo.messages.filter((m) => m.from === 'robot' && m.ts > vistoAte.current);
    if (!todas.length) return;
    vistoAte.current = Math.max(...todas.map((m) => m.ts));
    // Resposta a quem perguntou pelo celular (ou outro computador): fica no chat, sem balão aqui.
    const novas = todas.filter(eParaMim);
    if (!novas.length) return;
    const ultima = novas[novas.length - 1]!;
    // Se você abriu o balão para conversar, ele continua "seu": não some sozinho.
    setBalao((b) => ({ msg: ultima, desde: Date.now(), porClique: b?.porClique ?? false }));
    setEsperando(false);
    if (voz || falarProxima.current) {
      // Respondendo a um "Miro, …" e terminou perguntando: ouve a resposta sem precisar do nome.
      const perguntou = falarProxima.current && /\?\s*$/.test(ultima.text.trim());
      void speak(ultima.text).finally(() => perguntou && desktop?.ouvinteAtento?.(8000));
    }
    falarProxima.current = false;
  }, [robo.messages, voz]);

  // Tamanho da janela acompanha o balão. O que abriu sozinho some depois de um tempo, contado de
  // quando APARECEU (antes contava da hora da mensagem, e o balão aberto no clique fechava na hora).
  // O que VOCÊ abriu (clique, "Miro?") também fecha, só que com mais folga: depois de um tempo
  // sem mouse em cima nem digitação. Mexer no balão recomeça a conta.
  const mexeuEm = useRef(0);
  useEffect(() => {
    desktop?.modo(balao || esperando ? 'balao' : 'carinha');
    if (!balao || esperando) return;
    const leitura = BALAO_MIN_MS + (balao.msg?.text.length ?? 0) * BALAO_POR_LETRA_MS;
    const prazo = balao.porClique ? Math.max(BALAO_PARADO_MS, leitura) : leitura;
    const id = setInterval(() => {
      // Cursor piscando no campo não é mexer: só conta se esta janela ainda tem o foco.
      const mexendo = emCima || !!resposta.trim() || (document.hasFocus() && document.activeElement === inputRef.current);
      if (mexendo) mexeuEm.current = Date.now();
      else if (Date.now() - Math.max(balao.desde, mexeuEm.current) > prazo) setBalao(null);
    }, 1000);
    return () => clearInterval(id);
  }, [balao, esperando, emCima, resposta]);

  // Dormindo (o rosto do robô físico), a carinha não se mexe até alguém acordá-lo.
  const dormindo = robo.robot?.face === 'sleeping';
  useEffect(() => {
    desktop?.dormindo?.(dormindo);
  }, [dormindo]);

  // Com o balão aberto ou o mouse em cima, ela não sai passeando.
  useEffect(() => {
    desktop?.ocupada?.(!!balao || esperando || emCima);
  }, [balao, esperando, emCima]);

  /* ── "Miro, …" ── o ouvido do app (Electron) manda frases que podem ser o nome; o servidor confirma. */
  useEffect(() => {
    if (!desktop?.ouvinteAudio) return;
    let parar: (() => void) | null = null;
    fetch('/api/identidade', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((i: { nome?: string }) => i.nome && desktop?.ouvinteNome?.(i.nome))
      .catch(() => undefined);
    desktop.aoOuvir?.((sim) => {
      setOuvindo(sim);
      if (sim && !parar) {
        escutar((a) => desktop?.ouvinteAudio?.(a))
          .then((p) => (parar = p))
          .catch(() => undefined);
      } else if (!sim && parar) {
        parar();
        parar = null;
      }
    });
    desktop.aoCandidato?.((c) => void confirmarChamado(c.wav, !!c.seguimento));
    desktop.ouvintePronta?.();
    return () => parar?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const confirmarChamado = async (wav: Uint8Array, seguimento = false) => {
    setAtento(true);
    const t0 = Date.now();
    try {
      const res = await fetch(`/api/voice/chamado${seguimento ? '?seguimento=1' : ''}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav', ...cabecalhosDeOnde() },
        body: new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
      });
      const r = (await res.json()) as { chamou: boolean; texto?: string; comando?: string; ref?: string };
      console.log(`[miro] servidor (${Date.now() - t0} ms)${seguimento ? ' [continuação]' : ''}: "${r.texto ?? ''}" → ${r.chamou ? `chamou: "${r.comando ?? ''}"` : 'não era comigo'}`);
      if (r.chamou) executar(r.comando ?? '', r.ref);
    } catch (e) {
      console.log(`[miro] servidor falhou (${Date.now() - t0} ms): ${(e as Error).message}`);
      /* sem servidor agora: fica como se não tivesse ouvido */
    } finally {
      setAtento(false);
    }
  };

  /** O que veio depois do nome: comando do computador (na hora) ou conversa com ele. */
  const executar = (comando: string, ref?: string) => {
    const c = comando
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    const avisar = (texto: string) => {
      setBalao({ msg: { id: 'local', from: 'robot', text: texto, ts: Date.now() } as ChatMessage, desde: Date.now(), porClique: false });
      void speak(texto);
    };
    if (!c.trim()) {
      // Só "Miro?": abre o balão e fica esperando a continuação — sem precisar chamar de novo.
      setBalao({ msg: null, desde: Date.now(), porClique: true });
      void speak('Oi?').finally(() => desktop?.ouvinteAtento?.(8000));
      return;
    }
    if (/\b(grava|gravar|comeca|inicia|abre)\b.*\breuni/.test(c)) {
      desktop?.comando?.('reuniao:gravar');
      return avisar('Gravando a reunião.');
    }
    if (/\b(encerra|termina|para|finaliza|fecha)\b.*\breuni/.test(c)) {
      desktop?.comando?.('reuniao:encerrar');
      return avisar('Encerrando. Te aviso quando a ata ficar pronta.');
    }
    if (/\blink\b|\bconvite\b/.test(c)) {
      void convidar(token, '')
        .then((l) => {
          void navigator.clipboard?.writeText(l.url);
          avisar('Link da reunião copiado. Vale doze horas.');
        })
        .catch(() => avisar('Não consegui gerar o link agora.'));
      return;
    }
    if (/\b(abre|mostra)\b.*\bpainel\b/.test(c)) {
      desktop?.painel('abrir');
      return;
    }
    if (/^(esconde|some|sai)\b/.test(c)) {
      desktop?.esconder?.();
      return;
    }
    if (/\b(para|pare|parar) de (ouvir|escutar)\b|\bdesliga (o )?microfone\b|\bnao (me )?(ouve|escuta)\b/.test(c)) {
      avisar('Parei de ouvir. Para voltar, clique em mim e no microfone.');
      desktop?.ouvinteAlternar?.(false);
      return;
    }
    if (/\b(para de falar|cala|silencio|chega)\b/.test(c)) {
      stopSpeaking();
      return;
    }
    // O resto é conversa: vai para ele como se você tivesse digitado, e a resposta sai em voz.
    if (robo.say(comando, ref)) {
      falarProxima.current = true;
      setEsperando(true);
    } else {
      console.log('[miro] sem conexão com o servidor: comando perdido');
      avisar('Estou sem conexão agora. Tenta de novo daqui a pouco.');
    }
  };

  /** Clique na carinha: abre o balão para conversar (com a última mensagem, se for recente) ou fecha. */
  const clicar = () => {
    // Dormindo: o clique acorda (o robô da mesa também) antes de abrir o balão.
    if (dormindo) void fetch('/api/robot/acordar', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    if (balao) {
      setBalao(null);
      return;
    }
    const ultima = ultimaDoRobo(robo.messages);
    setBalao({ msg: ultima && Date.now() - ultima.ts < RECENTE_MS ? ultima : null, desde: Date.now(), porClique: true });
    desktop?.focar?.();
    setTimeout(() => inputRef.current?.focus(), 80);
  };

  const responder = (e: FormEvent) => {
    e.preventDefault();
    const t = resposta.trim();
    if (!t) return;
    if (robo.say(t)) {
      setResposta('');
      setEsperando(true);
    }
  };

  /* Quando ele fala, é só o balão de fala. O "Responder" e os botões aparecem com o mouse em
     cima, quando você abriu o balão para conversar, ou enquanto você está digitando. */
  const [digitando, setDigitando] = useState(false);
  const controles = emCima || !!balao?.porClique || digitando || !!resposta.trim();

  const r = robo.robot;
  const face = r?.online ? r.face : r?.thinking || esperando ? 'thinking' : 'neutral';
  const texto = esperando ? 'pensando…' : balao?.msg?.text ?? 'Oi! Fale comigo.';
  const tag = !esperando && balao?.msg?.kind ? TAG[balao.msg.kind] : undefined;

  return (
    <div className="bolha" onMouseEnter={() => setEmCima(true)} onMouseLeave={() => setEmCima(false)}>
      {(balao || esperando) && (
        <div className={`balao ${controles ? 'balao--aberto' : ''}`}>
          <div className="balao__topo" hidden={!tag && !controles}>
            {tag ? <span className="balao__tag">{tag}</span> : <span />}
            <span className="balao__botoes" hidden={!controles}>
              <button type="button" onClick={() => desktop?.painel('abrir')} title="Abrir o painel (chat, agenda, reunião)">
                ⤢
              </button>
              {ouvindo !== null && (
                <button
                  type="button"
                  onClick={() => desktop?.ouvinteAlternar?.(!ouvindo)}
                  title={ouvindo ? 'Parar de ouvir o "Miro, …"' : 'Voltar a ouvir o "Miro, …"'}
                  aria-pressed={ouvindo}
                >
                  {ouvindo ? <MicIcon /> : <MicOffIcon />}
                </button>
              )}
              <button type="button" onClick={trocarVoz} title={voz ? 'Parar de falar em voz alta' : 'Falar em voz alta'}>
                {voz ? '🔊' : '🔇'}
              </button>
              <button type="button" onClick={() => setBalao(null)} title="Fechar">
                ✕
              </button>
            </span>
          </div>
          <p className={`balao__texto ${esperando ? 'balao__texto--pensando' : ''} ${!balao?.msg && !esperando ? 'balao__texto--convite' : ''}`}>
            {texto}
          </p>
          <form className="balao__resposta" onSubmit={responder} hidden={!controles}>
            <input
              ref={inputRef}
              value={resposta}
              onFocus={() => setDigitando(true)}
              onBlur={() => setDigitando(false)}
              onChange={(e) => setResposta(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setBalao(null)}
              placeholder={balao?.msg ? 'Responder…' : 'Escreva aqui…'}
              disabled={robo.conn !== 'open'}
            />
          </form>
        </div>
      )}
      <Carinha
        andando={andando}
        face={robo.conn === 'open' ? (atento ? 'surprised' : andando ? 'happy' : face) : null}
        onClick={clicar}
        dica={balao ? 'Fechar o balão' : 'Falar com o Miro'}
        surdo={ouvindo === false}
      />
    </div>
  );
}

function ultimaDoRobo(msgs: ChatMessage[]): ChatMessage | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.from === 'robot') return msgs[i];
  return undefined;
}

/** O rosto redondo. Arrasta com o botão esquerdo; clique (sem arrastar) chama onClick. */
function Carinha({
  face,
  andando,
  onClick,
  onDoubleClick,
  dica,
  surdo = false,
}: {
  face: ChatMessage['face'] | null;
  andando: 'esquerda' | 'direita' | null;
  onClick(): void;
  onDoubleClick?(): void;
  dica: string;
  /** Não está ouvindo o "Miro, …": um microfone riscado no canto, para você lembrar. */
  surdo?: boolean;
}) {
  const inicio = useRef<{ x: number; y: number; arrastou: boolean } | null>(null);
  const gravando = useGravando();

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    inicio.current = { x: e.screenX, y: e.screenY, arrastou: false };
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const i = inicio.current;
    if (!i) return;
    const dx = e.screenX - i.x;
    const dy = e.screenY - i.y;
    if (!i.arrastou && Math.hypot(dx, dy) < ARRASTO_PX) return;
    i.arrastou = true;
    desktop?.mover(dx, dy);
    i.x = e.screenX;
    i.y = e.screenY;
  };
  const up = () => {
    const i = inicio.current;
    inicio.current = null;
    if (!i) return;
    if (i.arrastou) desktop?.soltar();
    else onClick();
  };

  return (
    <button
      type="button"
      className={`carinha ${andando ? `carinha--andando carinha--${andando}` : ''}`}
      title={dica}
      aria-label={dica}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onDoubleClick={onDoubleClick}
    >
      <RobotFace face={face ?? null} size={70} />
      {gravando && (
        <span className="carinha__rec" title="Gravando a reunião">
          <i /> {tempo(Date.now() - gravando)}
        </span>
      )}
      {surdo && (
        <span className="carinha__surdo" aria-hidden="true">
          <MicOffIcon />
        </span>
      )}
      {andando && (
        <span className="carinha__pes" aria-hidden="true">
          <i />
          <i />
        </span>
      )}
    </button>
  );
}

function tempo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
    </svg>
  );
}
