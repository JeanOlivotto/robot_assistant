import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ChatMessage, Proposal } from '@robo/protocol';
import { dayKey, dayLabel, hhmm } from '../lib/format';
import { preparePhoto, sendPhoto, usePhotoUrl, type ReadyPhoto } from '../lib/photo';
import { MAX_VOICE_MS, VoiceRecorder } from '../lib/recorder';

const KIND_TAG: Partial<Record<NonNullable<ChatMessage['kind']>, string>> = {
  reminder: 'lembrete',
  meeting: 'reunião',
};

const STATUS_TEXT: Record<Proposal['status'], string> = {
  pending: '',
  confirmed: '✅ Marcado na agenda',
  cancelled: 'Cancelado',
  expired: 'Expirou sem resposta',
  failed: 'Não deu certo',
};

function ProposalCard({ p, onConfirm }: { p: Proposal; onConfirm(ok: boolean): void }) {
  const [sent, setSent] = useState<boolean | null>(null);
  const pending = p.status === 'pending';
  return (
    <div className={`proposal proposal--${p.status}`}>
      <div className="proposal-title">{p.title}</div>
      {p.kind === 'command' ? (
        /* Proposta de comando: a linha exata aparece aqui — você aprova o que está vendo. */
        <code className="proposal-comando">{p.comando}</code>
      ) : (
        <div className="proposal-when">
          {dayLabel(p.start!)} · {hhmm(p.start!)} – {hhmm(p.end!)}
        </div>
      )}
      {pending ? (
        <div className="proposal-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={sent !== null}
            onClick={() => {
              setSent(true);
              onConfirm(true);
            }}
          >
            {sent === true ? (p.kind === 'command' ? 'Rodando…' : 'Marcando…') : p.kind === 'command' ? 'Pode rodar' : 'Confirmar'}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={sent !== null}
            onClick={() => {
              setSent(false);
              onConfirm(false);
            }}
          >
            Cancelar
          </button>
        </div>
      ) : (
        <div className="proposal-status">
          {STATUS_TEXT[p.status]}
          {p.error && p.status === 'failed' ? `: ${p.error}` : ''}
        </div>
      )}
    </div>
  );
}

const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M3.4 20.4 21 12 3.4 3.6l.1 6.5L15 12 3.5 13.9z" fill="currentColor" />
  </svg>
);

const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z" fill="currentColor" />
    <path d="M18 11a6 6 0 0 1-12 0M12 17v4M8.5 21h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

function Recording({ onDone, onCancel }: { onDone(audio: Blob): void; onCancel(): void }) {
  const [rec] = useState(() => new VoiceRecorder());
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [levels, setLevels] = useState<number[]>(() => Array(24).fill(0));
  const [error, setError] = useState('');
  const finished = useRef(false);

  useEffect(() => {
    let alive = true;
    rec
      .start()
      .then(() => alive && setStarted(Date.now()))
      .catch(() => alive && setError('Sem acesso ao microfone — libere nas configurações do Safari.'));
    const tick = setInterval(() => {
      setNow(Date.now());
      setLevels((l) => [...l.slice(1), rec.level()]);
    }, 80);
    return () => {
      alive = false;
      clearInterval(tick);
      if (!finished.current) rec.cancel();
    };
  }, [rec]);

  const finish = async () => {
    if (finished.current || !started) return;
    finished.current = true;
    onDone(await rec.stop());
  };

  // Limite de 2 min por mensagem de voz: para sozinho e envia.
  useEffect(() => {
    if (started && now - started >= MAX_VOICE_MS) void finish();
  });

  return (
    <div className="composer composer--rec">
      <button type="button" className="icon-circle" onClick={onCancel} aria-label="Cancelar gravação">
        <CloseIcon />
      </button>
      {error ? (
        <span className="rec-error">{error}</span>
      ) : (
        <div className="rec-meter" aria-live="polite">
          <span className="rec-dot" />
          <span className="rec-time">{started ? mmss(now - started) : '…'}</span>
          <span className="rec-bars" aria-hidden="true">
            {levels.map((l, i) => (
              <i key={i} style={{ height: `${Math.max(3, Math.round(l * 22))}px` }} />
            ))}
          </span>
        </div>
      )}
      <button type="button" className="send" onClick={finish} disabled={!started} aria-label="Enviar áudio">
        <SendIcon />
      </button>
    </div>
  );
}

/** Miniatura da foto na conversa, na proporção certa já antes de carregar (a lista não pula). */
function PhotoThumb({ token, photo, onOpen }: { token: string; photo: NonNullable<ChatMessage['photo']>; onOpen(url: string): void }) {
  const url = usePhotoUrl(token, photo.id);
  return (
    <button
      type="button"
      className="photo-thumb"
      style={{ aspectRatio: `${photo.w} / ${photo.h}` }}
      onClick={() => url && onOpen(url)}
      aria-label="Abrir foto"
    >
      {url ? <img src={url} alt="" /> : <span className="photo-thumb__wait">carregando…</span>}
    </button>
  );
}

function Composer({
  token,
  onSend,
  onSendVoice,
  disabled,
}: {
  token: string;
  onSend(text: string): boolean;
  onSendVoice(audio: Blob): Promise<string>;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<ReadyPhoto | null>(null);
  const [photoState, setPhotoState] = useState<'idle' | 'preparing' | 'sending'>('idle');
  const fileRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'sending' | 'error'>('idle');
  const [voiceError, setVoiceError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const dropPhoto = () => {
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto(null);
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoState('preparing');
    try {
      dropPhoto();
      setPhoto(await preparePhoto(file));
    } catch (err) {
      setVoiceError((err as Error).message);
      setVoiceState('error');
    } finally {
      setPhotoState('idle');
      if (fileRef.current) fileRef.current.value = ''; // deixa escolher a mesma foto de novo
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (disabled) return;
    if (photo) {
      // Foto com a legenda que estiver escrita: vai junto, numa mensagem só.
      setPhotoState('sending');
      try {
        await sendPhoto(token, photo, t);
        dropPhoto();
        setText('');
      } catch (err) {
        setVoiceError(`a foto não foi: ${(err as Error).message}`);
        setVoiceState('error');
      } finally {
        setPhotoState('idle');
      }
      return;
    }
    if (!t) return;
    if (onSend(t)) setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envia no computador; no celular o teclado tem o próprio botão.
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
      e.preventDefault();
      void submit();
    }
  };

  const sendVoice = async (audio: Blob) => {
    setRecording(false);
    setVoiceState('sending');
    try {
      await onSendVoice(audio);
      setVoiceState('idle');
    } catch (err) {
      setVoiceError((err as Error).message);
      setVoiceState('error');
    }
  };

  if (recording) return <Recording onDone={sendVoice} onCancel={() => setRecording(false)} />;

  const showMic = !text.trim() && !photo && VoiceRecorder.supported;
  return (
    <>
      {(photo || photoState === 'preparing') && (
        <div className="photo-draft">
          {photo ? <img src={photo.url} alt="Foto para enviar" /> : <span className="photo-draft__wait">preparando…</span>}
          <span className="photo-draft__hint">
            {photoState === 'sending' ? 'Enviando…' : 'Escreva algo sobre a foto, se quiser, e envie.'}
          </span>
          {photo && photoState !== 'sending' && (
            <button type="button" className="photo-draft__x" onClick={dropPhoto} aria-label="Tirar a foto">
              ×
            </button>
          )}
        </div>
      )}
      {voiceState !== 'idle' && (
        <div className={`voice-status voice-status--${voiceState}`} onClick={() => voiceState === 'error' && setVoiceState('idle')}>
          {voiceState === 'sending' ? 'Ouvindo seu áudio…' : `Não deu: ${voiceError} (toque para fechar)`}
        </div>
      )}
      <form className="composer" onSubmit={(e) => void submit(e)}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => void pickPhoto(e.target.files?.[0])}
        />
        <button
          type="button"
          className="attach"
          disabled={disabled || photoState !== 'idle'}
          onClick={() => fileRef.current?.click()}
          aria-label="Mandar foto"
        >
          <CameraIcon />
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={disabled ? 'Sem conexão…' : photo ? 'Legenda (opcional)…' : 'Fale com o robô…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          enterKeyHint="send"
        />
        {showMic ? (
          <button
            type="button"
            className="send"
            disabled={disabled || voiceState === 'sending'}
            onClick={() => setRecording(true)}
            aria-label="Gravar mensagem de voz"
          >
            <MicIcon />
          </button>
        ) : (
          <button
            type="submit"
            className="send"
            disabled={disabled || photoState !== 'idle' || (!text.trim() && !photo)}
            aria-label="Enviar"
          >
            <SendIcon />
          </button>
        )}
      </form>
    </>
  );
}

function CameraIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export function Chat({
  token,
  messages,
  thinking,
  online,
  onSay,
  onSendVoice,
  onConfirm,
}: {
  token: string;
  messages: ChatMessage[];
  thinking: boolean;
  online: boolean;
  onSay(text: string): boolean;
  onSendVoice(audio: Blob): Promise<string>;
  onConfirm(proposalId: string, ok: boolean): void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, thinking]);

  return (
    <div className="chat">
      <div className="thread">
        {messages.length === 0 && (
          <p className="empty">Diga oi! Dá para perguntar da agenda ou pedir para marcar um compromisso.</p>
        )}
        {messages.map((m, i) => {
          const newDay = i === 0 || dayKey(messages[i - 1]!.ts) !== dayKey(m.ts);
          const tag = m.kind ? KIND_TAG[m.kind] : undefined;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day">{dayLabel(m.ts)}</div>}
              <div className={`msg msg--${m.from}`}>
                <div className="bubble">
                  {tag && <div className="tag">{tag}</div>}
                  {m.photo && <PhotoThumb token={token} photo={m.photo} onOpen={setViewing} />}
                  {m.text && <div className="text">{m.text}</div>}
                  {m.proposal && <ProposalCard p={m.proposal} onConfirm={(ok) => onConfirm(m.proposal!.id, ok)} />}
                  <div className="time">
                    {m.via === 'voice' ? `🎤 ${m.voz?.certeza === 'alta' ? `${m.voz.nome} · ` : ''}` : m.via === 'siri' ? 'Siri · ' : ''}
                    {hhmm(m.ts)}
                  </div>
                </div>
              </div>
            </Fragment>
          );
        })}
        {thinking && (
          <div className="msg msg--robot">
            <div className="bubble typing" aria-label="pensando">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <Composer token={token} onSend={onSay} onSendVoice={onSendVoice} disabled={!online} />
      {viewing && (
        <div className="photo-viewer" onClick={() => setViewing(null)} role="dialog" aria-label="Foto (toque para fechar)">
          <img src={viewing} alt="" />
        </div>
      )}
    </div>
  );
}
