import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ChatMessage, Proposal } from '@robo/protocol';
import { dayKey, dayLabel, hhmm } from '../lib/format';

const KIND_TAG: Partial<Record<NonNullable<ChatMessage['kind']>, string>> = {
  proactive: 'mandou sozinho',
  reminder: 'lembrete',
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
      <div className="proposal-when">
        {dayLabel(p.start)} · {hhmm(p.start)} – {hhmm(p.end)}
      </div>
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
            {sent === true ? 'Marcando…' : 'Confirmar'}
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

function Composer({ onSend, disabled }: { onSend(text: string): boolean; disabled: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    if (onSend(t)) setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envia no computador; no celular o teclado tem o próprio botão.
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={disabled ? 'Sem conexão…' : 'Fale com o robô…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        enterKeyHint="send"
      />
      <button type="submit" className="send" disabled={disabled || !text.trim()} aria-label="Enviar">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M3.4 20.4 21 12 3.4 3.6l.1 6.5L15 12 3.5 13.9z" fill="currentColor" />
        </svg>
      </button>
    </form>
  );
}

export function Chat({
  messages,
  thinking,
  online,
  onSay,
  onConfirm,
}: {
  messages: ChatMessage[];
  thinking: boolean;
  online: boolean;
  onSay(text: string): boolean;
  onConfirm(proposalId: string, ok: boolean): void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

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
                  <div className="text">{m.text}</div>
                  {m.proposal && <ProposalCard p={m.proposal} onConfirm={(ok) => onConfirm(m.proposal!.id, ok)} />}
                  <div className="time">{hhmm(m.ts)}</div>
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
      <Composer onSend={onSay} disabled={!online} />
    </div>
  );
}
