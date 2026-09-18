import { useEffect, useRef, useState } from 'react';
import { speakUntilDone, stopSpeaking } from '../lib/speech';
import { Listener, converse } from '../lib/voicechat';

type Phase = 'speaking' | 'listening' | 'thinking' | 'paused' | 'error';

/**
 * Modo conversa por voz: o robô fala, escuta a resposta (para sozinho no silêncio) e continua.
 * Um toque abre; daí é só conversar. Fecha quando você encerra.
 */
export function VoiceConversation({ token, initialText, onClose }: { token: string; initialText?: string; onClose(): void }) {
  const [phase, setPhase] = useState<Phase>('speaking');
  const [hint, setHint] = useState('');
  const [you, setYou] = useState('');
  const [reply, setReply] = useState(initialText ?? '');
  const [level, setLevel] = useState(0);

  const listener = useRef<Listener | null>(null);
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    void run(initialText);
    return () => {
      closed.current = true;
      listener.current?.abort();
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Um turno: (fala pendente →) escuta → pensa → fala → repete. */
  async function run(sayFirst?: string): Promise<void> {
    if (closed.current) return;
    try {
      if (sayFirst) {
        setPhase('speaking');
        setReply(sayFirst);
        await speakUntilDone(sayFirst);
      }
      await listenTurn();
    } catch (e) {
      if (closed.current) return;
      setHint((e as Error).message);
      setPhase('error');
    }
  }

  async function listenTurn(): Promise<void> {
    if (closed.current) return;
    if (!Listener.supported) {
      setHint('Este navegador não grava áudio.');
      setPhase('error');
      return;
    }
    setPhase('listening');
    setHint('Pode falar…');
    const l = new Listener();
    listener.current = l;
    const blob = await l.listen(
      (v) => setLevel(v),
      (s) => setHint(s === 'speaking' ? 'Ouvindo…' : 'Pode falar…'),
    );
    if (closed.current) return;
    if (!blob) {
      setPhase('paused');
      setHint('Não te ouvi. Toque em Falar quando quiser.');
      return;
    }
    setPhase('thinking');
    setLevel(0);
    try {
      const r = await converse(token, blob);
      if (closed.current) return;
      setYou(r.you);
      setReply(r.reply);
      setPhase('speaking');
      await speakUntilDone(r.reply);
      if (closed.current) return;
      void listenTurn(); // continua a conversa
    } catch (e) {
      if (closed.current) return;
      const msg = (e as Error).message.includes('422') ? 'Não entendi o que você falou. Toque em Falar e tente de novo.' : (e as Error).message;
      setHint(msg);
      setPhase('paused');
    }
  }

  const orbClass = phase === 'listening' ? 'orb orb--listen' : phase === 'speaking' ? 'orb orb--speak' : phase === 'thinking' ? 'orb orb--think' : 'orb';
  const scale = phase === 'listening' ? 1 + level * 0.6 : 1;

  return (
    <div className="convo">
      <button type="button" className="convo__close" onClick={onClose} aria-label="Encerrar conversa">
        ✕
      </button>
      <div className="convo__stage">
        <div className={orbClass} style={{ transform: `scale(${scale})` }} aria-hidden="true" />
        <p className="convo__phase">
          {phase === 'listening' && hint}
          {phase === 'thinking' && 'Pensando…'}
          {phase === 'speaking' && 'Falando…'}
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
          <button type="button" className="rec-btn" onClick={() => listener.current?.submit()}>
            Enviar
          </button>
        )}
        {(phase === 'paused' || phase === 'error') && (
          <button type="button" className="rec-btn" onClick={() => void listenTurn()}>
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
