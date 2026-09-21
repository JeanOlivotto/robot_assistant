import { useEffect, useRef, useState } from 'react';
import { type Speaking, speakStream, stopSpeaking } from '../lib/speech';
import { VoiceSession, converse, startCall } from '../lib/voicechat';

type Phase = 'connecting' | 'speaking' | 'listening' | 'thinking' | 'paused' | 'error';

/**
 * Modo chamada: um toque abre e daí é só conversar. Cada chamada é uma conversa NOVA
 * (ele não volta repetindo a última mensagem do chat, mas continua lembrando do que importa),
 * o microfone fica aberto do começo ao fim e você pode cortar a fala dele falando por cima.
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
  const [you, setYou] = useState('');
  const [reply, setReply] = useState('');
  const [level, setLevel] = useState(0);

  const mic = useRef<VoiceSession | null>(null);
  const session = useRef('');
  const talking = useRef<Speaking | null>(null);
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    void start();
    return () => {
      closed.current = true;
      talking.current?.stop();
      stopSpeaking();
      mic.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setReply(text);
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

    while (!closed.current) {
      const s = mic.current;
      if (!s) return;
      setPhase('listening');
      setHint('Pode falar…');
      const blob = await s.listen({
        onLevel: setLevel,
        onState: (st) => setHint(st === 'speaking' ? 'Ouvindo…' : 'Pode falar…'),
        preRollMs,
      });
      preRollMs = undefined;
      if (closed.current) return;
      if (!blob) {
        setPhase('paused');
        setHint('Tô aqui — toque em Falar quando quiser.');
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
          setHint('Não peguei... pode repetir?');
          continue;
        }
        setHint(/422|não entendi/i.test(msg) ? 'Não entendi o que você falou. Toque em Falar e tente de novo.' : msg);
        setPhase('paused');
        return;
      }
      misses = 0;
      if (closed.current) return;
      setYou(answer.you);

      const cut = await say(answer.reply);
      if (closed.current) return;
      if (answer.action === 'start_meeting') {
        onStartMeeting(); // sai da chamada e entra no modo reunião (o microfone continua liberado)
        return;
      }
      preRollMs = cut ? VoiceSession.bargePreRollMs : undefined;
    }
  }

  const orbClass =
    phase === 'listening' ? 'orb orb--listen' : phase === 'speaking' ? 'orb orb--speak' : phase === 'thinking' ? 'orb orb--think' : 'orb';
  const scale = phase === 'listening' ? 1 + level * 0.6 : 1;

  return (
    <div className="convo">
      <button type="button" className="convo__close" onClick={onClose} aria-label="Encerrar conversa">
        ✕
      </button>
      <div className="convo__stage">
        <div className={orbClass} style={{ transform: `scale(${scale})` }} aria-hidden="true" />
        <p className="convo__phase">
          {phase === 'connecting' && 'Chamando…'}
          {phase === 'listening' && hint}
          {phase === 'thinking' && 'Pensando…'}
          {phase === 'speaking' && 'Falando… (pode me cortar)'}
          {phase === 'paused' && hint}
          {phase === 'error' && (hint || 'Deu ruim aqui.')}
        </p>
      </div>

      <div className="convo__lines">
        {you && <p className="convo__you">“{you}”</p>}
        {reply && <p className="convo__reply">{reply}</p>}
      </div>

      <div className="convo__controls">
        {phase === 'listening' && (
          <button type="button" className="rec-btn" onClick={() => mic.current?.submit()}>
            Enviar
          </button>
        )}
        {(phase === 'paused' || phase === 'error') && (
          <button type="button" className="rec-btn" onClick={() => void loop()}>
            Falar
          </button>
        )}
        <button type="button" className="mini-btn" onClick={onClose}>
          Encerrar conversa
        </button>
      </div>
    </div>
  );
}

/** Recusar o microfone é o erro mais comum aqui — vale explicar em vez de mostrar o nome da exceção. */
function micError(e: Error): string {
  if (/NotAllowed|Permission/i.test(e.name + e.message)) return 'Preciso do microfone para conversar: libere nas permissões do site.';
  if (/NotFound|Devices/i.test(e.name + e.message)) return 'Não achei nenhum microfone neste aparelho.';
  return e.message;
}
