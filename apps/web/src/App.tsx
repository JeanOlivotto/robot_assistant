import { useEffect, useRef, useState } from 'react';
import { Agenda } from './components/Agenda';
import { Chat } from './components/Chat';
import { Login } from './components/Login';
import { RobotFace } from './components/RobotFace';
import { ago } from './lib/format';
import { speak, speechSupported, stopSpeaking } from './lib/speech';
import { useRobo } from './lib/useRobo';

const TOKEN_KEY = 'robo.token';
const SPEAK_KEY = 'robo.speak';

function loadToken(): string | null {
  // Link com ?k=senha entra direto (e a senha sai da barra de endereço).
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('k');
  if (fromUrl) {
    url.searchParams.delete('k');
    history.replaceState(null, '', url);
    saveToken(fromUrl);
    return fromUrl;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* modo privado: fica só na memória */
  }
}

/** Re-renderiza de tempos em tempos para o "há X min" andar. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function Main({ token, onLogout }: { token: string; onLogout(): void }) {
  const robo = useRobo(token);
  const [tab, setTab] = useState<'chat' | 'agenda'>('chat');
  const now = useNow(30_000);
  const r = robo.robot;
  const [speakOn, setSpeakOn] = useState(() => {
    try {
      return localStorage.getItem(SPEAK_KEY) === '1';
    } catch {
      return false;
    }
  });
  const spokenUpTo = useRef(Date.now());

  // Lê em voz alta só o que o robô disser depois de ligar (não o histórico).
  useEffect(() => {
    if (!speakOn) return;
    const fresh = robo.messages.filter((m) => m.from === 'robot' && m.ts > spokenUpTo.current);
    if (!fresh.length) return;
    spokenUpTo.current = Math.max(...fresh.map((m) => m.ts));
    speak(fresh[fresh.length - 1]!.text);
  }, [robo.messages, speakOn]);

  const toggleSpeak = () => {
    const on = !speakOn;
    setSpeakOn(on);
    try {
      localStorage.setItem(SPEAK_KEY, on ? '1' : '0');
    } catch {
      /* só nesta sessão */
    }
    spokenUpTo.current = Date.now();
    // No iPhone a voz só funciona depois de um toque: este é o toque.
    if (on) speak('Beleza, vou ler minhas respostas.');
    else stopSpeaking();
  };

  let status: string;
  if (robo.conn !== 'open') status = 'reconectando…';
  else if (r?.thinking) status = 'pensando…';
  else if (r?.waiting_since) status = `esperando você ${ago(r.waiting_since, now)}`;
  else if (!r?.online) status = 'robô desligado — o chat funciona igual';
  else status = 'na mesa, de olho em você';

  const face = r?.online ? r.face : r?.thinking ? 'thinking' : null;

  return (
    <div className="app">
      <header className="top">
        <RobotFace face={face} size={52} className={r?.online ? '' : 'face--offline'} />
        <div className="who">
          <strong>Robô</strong>
          <span className={`status ${robo.conn !== 'open' ? 'status--warn' : r?.waiting_since ? 'status--wait' : ''}`}>{status}</span>
        </div>
        {speechSupported && (
          <button
            type="button"
            className={`icon-btn ${speakOn ? 'icon-btn--on' : ''}`}
            onClick={toggleSpeak}
            aria-pressed={speakOn}
            aria-label={speakOn ? 'Parar de ler as respostas' : 'Ler as respostas em voz alta'}
            title={speakOn ? 'Lendo as respostas em voz alta' : 'Ler as respostas em voz alta'}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
              {speakOn ? (
                <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              ) : (
                <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              )}
            </svg>
          </button>
        )}
        <button type="button" className="icon-btn" onClick={onLogout} aria-label="Sair" title="Sair">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          Conversa
        </button>
        <button role="tab" aria-selected={tab === 'agenda'} className={tab === 'agenda' ? 'on' : ''} onClick={() => setTab('agenda')}>
          Agenda{robo.agenda.length ? ` · ${robo.agenda.filter((i) => i.end > now).length}` : ''}
        </button>
      </nav>

      {tab === 'chat' ? (
        <Chat
          messages={robo.messages}
          thinking={!!r?.thinking}
          online={robo.conn === 'open'}
          onSay={robo.say}
          onSendVoice={robo.sendVoice}
          onConfirm={robo.confirm}
        />
      ) : (
        <Agenda items={robo.agenda} />
      )}
    </div>
  );
}

export function App() {
  const [token, setToken] = useState<string | null>(loadToken);

  if (!token) {
    return (
      <Login
        onLogin={(t) => {
          saveToken(t);
          setToken(t);
        }}
      />
    );
  }
  return (
    <Main
      token={token}
      onLogout={() => {
        saveToken(null);
        setToken(null);
      }}
    />
  );
}
