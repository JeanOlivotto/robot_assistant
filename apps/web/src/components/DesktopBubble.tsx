import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import type { ChatMessage } from '@robo/protocol';
import { desktop } from '../lib/desktop';
import { configureSpeech, speak, stopSpeaking } from '../lib/speech';
import { useRobo } from '../lib/useRobo';
import { RobotFace } from './RobotFace';

const TOKEN_KEY = 'robo.token';
const VOZ_KEY = 'robo.desktopVoz';
/** O balão some sozinho depois disso (mais tempo para texto longo), a não ser que o mouse esteja nele. */
const BALAO_MIN_MS = 9000;
const BALAO_POR_LETRA_MS = 45;
/** Mexeu mais que isso com o botão apertado: é arrastar, não clicar. */
const ARRASTO_PX = 4;

const TAG: Partial<Record<NonNullable<ChatMessage['kind']>, string>> = {
  proactive: 'mandou sozinho',
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

  // O login acontece no painel (a outra janela): quando ele grava a senha, a bolha acorda.
  useEffect(() => {
    if (token) return;
    const onStorage = () => setToken(lerToken());
    window.addEventListener('storage', onStorage);
    const id = setInterval(onStorage, 3000);
    return () => {
      window.removeEventListener('storage', onStorage);
      clearInterval(id);
    };
  }, [token]);

  if (!token) return <Carinha face={null} onClick={() => desktop?.painel('abrir')} dica="Clique para entrar" />;
  return <BolhaLogada token={token} />;
}

function BolhaLogada({ token }: { token: string }) {
  const robo = useRobo(token);
  const [balao, setBalao] = useState<ChatMessage | null>(null);
  const [resposta, setResposta] = useState('');
  const [esperando, setEsperando] = useState(false);
  const [voz, setVoz] = useState(() => {
    try {
      return localStorage.getItem(VOZ_KEY) === '1';
    } catch {
      return false;
    }
  });
  const vistoAte = useRef(Date.now()); // o histórico que já existia não vira balão
  const segurando = useRef(false); // mouse em cima ou digitando: o balão não some
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void configureSpeech(token);
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
    const novas = robo.messages.filter((m) => m.from === 'robot' && m.ts > vistoAte.current);
    if (!novas.length) return;
    vistoAte.current = Math.max(...novas.map((m) => m.ts));
    const ultima = novas[novas.length - 1]!;
    setBalao(ultima);
    setEsperando(false);
    if (voz) void speak(ultima.text);
  }, [robo.messages, voz]);

  // Tamanho da janela acompanha o balão; o balão some sozinho depois de um tempo.
  useEffect(() => {
    desktop?.modo(balao || esperando ? 'balao' : 'carinha');
    if (!balao || esperando) return;
    const prazo = BALAO_MIN_MS + balao.text.length * BALAO_POR_LETRA_MS;
    const id = setInterval(() => {
      if (!segurando.current && document.activeElement !== inputRef.current && Date.now() - balao.ts > prazo) setBalao(null);
    }, 1000);
    return () => clearInterval(id);
  }, [balao, esperando]);

  const responder = (e: FormEvent) => {
    e.preventDefault();
    const t = resposta.trim();
    if (!t) return;
    if (robo.say(t)) {
      setResposta('');
      setEsperando(true);
    }
  };

  const r = robo.robot;
  const face = r?.online ? r.face : r?.thinking || esperando ? 'thinking' : 'neutral';
  const texto = esperando ? 'pensando…' : balao?.text;
  const tag = balao?.kind ? TAG[balao.kind] : undefined;

  return (
    <div className="bolha">
      {(balao || esperando) && (
        <div
          className="balao"
          onMouseEnter={() => (segurando.current = true)}
          onMouseLeave={() => (segurando.current = false)}
        >
          <div className="balao__topo">
            {tag ? <span className="balao__tag">{tag}</span> : <span />}
            <span className="balao__botoes">
              <button type="button" onClick={trocarVoz} title={voz ? 'Parar de falar em voz alta' : 'Falar em voz alta'}>
                {voz ? '🔊' : '🔇'}
              </button>
              <button type="button" onClick={() => setBalao(null)} title="Fechar">
                ✕
              </button>
            </span>
          </div>
          <p className={`balao__texto ${esperando ? 'balao__texto--pensando' : ''}`}>{texto}</p>
          <form className="balao__resposta" onSubmit={responder}>
            <input
              ref={inputRef}
              value={resposta}
              onChange={(e) => setResposta(e.target.value)}
              placeholder="Responder…"
              disabled={robo.conn !== 'open'}
            />
          </form>
        </div>
      )}
      <Carinha
        face={robo.conn === 'open' ? face : null}
        onClick={() => (balao ? desktop?.painel('alternar') : setBalao(ultimaDoRobo(robo.messages) ?? null))}
        onDoubleClick={() => desktop?.painel('alternar')}
        dica={balao ? 'Clique para abrir o painel' : 'Clique para ver a última mensagem'}
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
  onClick,
  onDoubleClick,
  dica,
}: {
  face: ChatMessage['face'] | null;
  onClick(): void;
  onDoubleClick?(): void;
  dica: string;
}) {
  const inicio = useRef<{ x: number; y: number; arrastou: boolean } | null>(null);

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
      className="carinha"
      title={dica}
      aria-label={dica}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onDoubleClick={onDoubleClick}
    >
      <RobotFace face={face ?? null} size={70} />
    </button>
  );
}
