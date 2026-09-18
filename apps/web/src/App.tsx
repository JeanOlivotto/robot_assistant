import { useEffect, useState } from 'react';
import { Agenda } from './components/Agenda';
import { Chat } from './components/Chat';
import { Login } from './components/Login';
import { RobotFace } from './components/RobotFace';
import { ago } from './lib/format';
import { useRobo } from './lib/useRobo';

const TOKEN_KEY = 'robo.token';

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
