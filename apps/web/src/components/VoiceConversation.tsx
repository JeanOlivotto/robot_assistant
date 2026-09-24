import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type Speaking, speakStream, stopSpeaking } from '../lib/speech';
import { VoiceSession, converse, startCall } from '../lib/voicechat';

type Phase = 'connecting' | 'speaking' | 'listening' | 'thinking' | 'paused' | 'error';

interface Turn {
  who: 'you' | 'robot';
  text: string;
}

/** Ninguém fala por este tempo: a ligação pausa (antes eram 8 s e ele desistia cedo demais). */
const IDLE_PAUSE_MS = 2 * 60_000;

/**
 * Modo chamada, no jeito dos agentes de voz de hoje: a conversa corre como um chat na tela e o
 * círculo embaixo mostra o que ele está fazendo — ouvindo (reage à sua voz), pensando (pontinhos)
 * ou falando (pontinhos conversando e ondas). Um toque abre, e daí é só conversar: ele volta a
 * ouvir sozinho depois de cada resposta, e você pode cortá-lo falando por cima.
 */
export function VoiceConversation({
  token,
  onClose,
  onStartMeeting,
}: {
  token: string;
  onClose(): void;
  onStartMeeting(): void;
}) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [hint, setHint] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [level, setLevel] = useState(0);
  const [hearing, setHearing] = useState(false);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const mic = useRef<VoiceSession | null>(null);
  const session = useRef('');
  const talking = useRef<Speaking | null>(null);
  const closed = useRef(false);
  const startedAt = useRef(Date.now());
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    closed.current = false;
    void start();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => {
      closed.current = true;
      clearInterval(t);
      talking.current?.stop();
      stopSpeaking();
      mic.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [turns.length, phase]);

  const add = (who: Turn['who'], text: string) => setTurns((t) => [...t, { who, text }]);

  /** Atende: abre o microfone e a conversa nova ao mesmo tempo, dá um oi e começa a escutar. */
  async function start(): Promise<void> {
    if (!VoiceSession.supported) {
      setHint('Este navegador não grava áudio.');
      setPhase('error');
      return;
    }
    const s = new VoiceSession();
    mic.current = s;
    try {
      const [call] = await Promise.all([startCall(token), s.open()]);
      if (closed.current) return;
      session.current = call.session;
      startedAt.current = Date.now();
      const cut = await say(call.greeting);
      await loop(cut);
    } catch (e) {
      if (closed.current) return;
      setHint(micError(e as Error));
      setPhase('error');
    }
  }

  /** Fala e fica de ouvido: devolve true se você o interrompeu no meio. */
  async function say(text: string): Promise<boolean> {
    const s = mic.current;
    if (!s || closed.current) return false;
    setPhase('speaking');
    add('robot', text);
    const handle = speakStream(text, () => s.armBargeIn()); // vigia só depois que o som sai
    talking.current = handle;
    const cut = await Promise.race([handle.done.then(() => false), s.watchBargeIn()]);
    if (cut) handle.stop();
    else s.stopWatching();
    talking.current = null;
    return cut;
  }

  /** A conversa em si, um turno atrás do outro, até você encerrar. */
  async function loop(afterBargeIn = false): Promise<void> {
    let preRollMs = afterBargeIn ? VoiceSession.bargePreRollMs : undefined;
    let misses = 0;
    let quietSince = Date.now();

    while (!closed.current) {
      const s = mic.current;
      if (!s) return;
      setPhase('listening');
      setHearing(false);
      const blob = await s.listen({
        onLevel: setLevel,
        onState: (st) => setHearing(st === 'speaking'),
        preRollMs,
      });
      preRollMs = undefined;
      if (closed.current) return;
      if (!blob) {
        // Ninguém falou nesta rodada: continua ouvindo, como numa ligação de verdade.
        if (Date.now() - quietSince < IDLE_PAUSE_MS) continue;
        setPhase('paused');
        setHint('Fiquei um tempo sem ouvir nada. Toque em Falar para continuar.');
        return;
      }

      setPhase('thinking');
      setLevel(0);
      let answer;
      try {
        answer = await converse(token, blob, session.current);
      } catch (e) {
        if (closed.current) return;
        const msg = (e as Error).message;
        // Não entendeu o áudio: volta a escutar sem drama — só desiste se acontecer de novo.
        if (/422|não entendi/i.test(msg) && misses < 2) {
          misses += 1;
          setHint('Não peguei… pode repetir?');
          continue;
        }
        setHint(/422|não entendi/i.test(msg) ? 'Não entendi o que você falou. Toque em Falar e tente de novo.' : msg);
        setPhase('paused');
        return;
      }
      misses = 0;
      setHint('');
      if (closed.current) return;
      add('you', answer.you);

      const cut = await say(answer.reply);
      if (closed.current) return;
      if (answer.action === 'start_meeting') {
        onStartMeeting(); // sai da chamada e entra no modo reunião (o microfone continua liberado)
        return;
      }
      preRollMs = cut ? VoiceSession.bargePreRollMs : undefined;
      quietSince = Date.now();
    }
  }

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mic.current?.setMuted(next);
  };

  const status =
    phase === 'connecting'
      ? 'Chamando…'
      : phase === 'listening'
        ? muted
          ? 'Microfone mudo'
          : hint || (hearing ? 'Ouvindo…' : 'Pode falar')
        : phase === 'thinking'
          ? 'Pensando…'
          : phase === 'speaking'
            ? 'Falando — pode me cortar'
            : hint || 'Deu ruim aqui.';

  return (
    <div className="call" role="dialog" aria-label="Ligação com o robô">
      <header className="call__top">
        <div className="call__who">
          <strong>Robô</strong>
          <span>{phase === 'connecting' ? 'chamando…' : mmss(elapsed)}</span>
        </div>
        <button type="button" className="call__x" onClick={onClose} aria-label="Encerrar ligação">
          ✕
        </button>
      </header>

      <div className="call__thread">
        {turns.length === 0 && <p className="call__empty">Conectando…</p>}
        {turns.map((t, i) => (
          <div key={i} className={`call__msg call__msg--${t.who}`}>
            <p>{t.text}</p>
          </div>
        ))}
        {phase === 'thinking' && (
          <div className="call__msg call__msg--robot">
            <p className="call__typing" aria-label="pensando">
              <span />
              <span />
              <span />
            </p>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="call__stage">
        <Orb phase={muted && phase === 'listening' ? 'paused' : phase} level={hearing ? level : level * 0.4} />
        <p className="call__status" aria-live="polite">
          {status}
        </p>
      </div>

      <footer className="call__controls">
        <button
          type="button"
          className={`call__btn ${muted ? 'call__btn--on' : ''}`}
          onClick={toggleMute}
          aria-pressed={muted}
          aria-label={muted ? 'Ligar o microfone' : 'Mutar o microfone'}
        >
          {muted ? <MicOffIcon /> : <MicIcon />}
        </button>
        {(phase === 'paused' || phase === 'error') && (
          <button type="button" className="call__btn call__btn--falar" onClick={() => void loop()}>
            Falar
          </button>
        )}
        <button type="button" className="call__btn call__btn--fim" onClick={onClose} aria-label="Encerrar ligação">
          <HangUpIcon />
        </button>
      </footer>
    </div>
  );
}

/**
 * O círculo que mostra o estado. Ouvindo: cresce com a sua voz. Pensando: três pontinhos
 * pulando. Falando: os pontinhos "conversam" e saem ondas do círculo.
 */
function Orb({ phase, level }: { phase: Phase; level: number }) {
  const listening = phase === 'listening';
  return (
    <div className={`orb2 orb2--${phase}`} aria-hidden="true">
      {phase === 'speaking' && (
        <>
          <span className="orb2__wave" />
          <span className="orb2__wave orb2__wave--2" />
        </>
      )}
      <div className="orb2__core" style={listening ? { transform: `scale(${1 + level * 0.35})` } : undefined}>
        {(phase === 'thinking' || phase === 'speaking' || phase === 'connecting') && (
          <span className="orb2__dots">
            <i />
            <i />
            <i />
          </span>
        )}
        {listening && (
          <span className="orb2__bars">
            {[0.55, 0.85, 1, 0.85, 0.55].map((k, i) => (
              <i key={i} style={{ transform: `scaleY(${0.25 + Math.min(1, level * 1.6) * k})` }} />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function mmss(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function MicIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 9c-2.6 0-5.1.5-7.3 1.5-.9.4-1.4 1.3-1.3 2.3l.2 1.6c.1.9.9 1.5 1.8 1.4l2.7-.4c.8-.1 1.4-.8 1.4-1.6v-1.5c1.6-.4 3.3-.4 5 0v1.5c0 .8.6 1.5 1.4 1.6l2.7.4c.9.1 1.7-.5 1.8-1.4l.2-1.6c.1-1-.4-1.9-1.3-2.3C17.1 9.5 14.6 9 12 9z" />
    </svg>
  );
}

/** Recusar o microfone é o erro mais comum aqui — vale explicar em vez de mostrar o nome da exceção. */
function micError(e: Error): string {
  if (/NotAllowed|Permission/i.test(e.name + e.message)) return 'Preciso do microfone para conversar: libere nas permissões do site.';
  if (/NotFound|Devices/i.test(e.name + e.message)) return 'Não achei nenhum microfone neste aparelho.';
  return e.message;
}
