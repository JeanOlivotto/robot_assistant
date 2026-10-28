import { useEffect, useRef, useState } from 'react';
import { Agenda } from './components/Agenda';
import { Lateral } from './components/Lateral';
import { Memoria } from './components/Memoria';
import { lerEstado, type EstadoDoMiro } from './lib/memoria';
import { Chat } from './components/Chat';
import { Login } from './components/Login';
import { MeetingView } from './components/Meeting';
import { RobotFace } from './components/RobotFace';
import { Guest } from './components/Guest';
import { Tasks } from './components/Tasks';
import { VoiceConversation } from './components/VoiceConversation';
import { ago } from './lib/format';
import { enablePush, pushState, refreshPush, testPush, type PushState } from './lib/push';
import { audioContext, closeMic } from './lib/mic';
import { configureSpeech, speak, speechSupported, stopSpeaking, unlockAudio } from './lib/speech';
import { DESKTOP, desktop } from './lib/desktop';
import { useRobo } from './lib/useRobo';
import { Computador } from './components/Computador';
import { eParaMim } from './lib/origem';

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

type Tab = 'chat' | 'agenda' | 'pendencias' | 'reuniao' | 'pc' | 'memoria';

/** As abas do painel largo (no computador), com o ícone da barra lateral. */
const ABAS: { id: Tab; nome: string; icone: string }[] = [
  { id: 'chat', nome: 'Conversa', icone: 'M4 5h16v11H9l-5 4V5Z' },
  { id: 'agenda', nome: 'Agenda', icone: 'M4 6h16v14H4V6Zm0 4h16M8 3v4m8-4v4' },
  { id: 'pendencias', nome: 'Pendências', icone: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2' },
  { id: 'memoria', nome: 'Memória', icone: 'M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M5 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M19 7m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6.5 7.3l3.6 3M17.3 8.2l-3.2 2.4M7.4 17.6l3-3.6' },
  { id: 'reuniao', nome: 'Reunião', icone: 'M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Zm-6 8a6 6 0 0 0 12 0M12 18v3' },
  {
    id: 'pc',
    nome: 'Ajustes',
    icone:
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  },
];

/** O painel do computador (e o navegador largo) ganha três colunas; o celular continua com abas. */
const LARGO = '(min-width: 1080px)';
function useLargo(): boolean {
  const [largo, setLargo] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(LARGO).matches);
  useEffect(() => {
    const mq = matchMedia(LARGO);
    const mudou = () => setLargo(mq.matches);
    mq.addEventListener('change', mudou);
    return () => mq.removeEventListener('change', mudou);
  }, []);
  return largo;
}

/** Atalho da Siri pode abrir o app já numa aba: ?tab=reuniao (ou #reuniao). */
function initialTab(): Tab {
  const raw = (new URL(location.href).searchParams.get('tab') || location.hash.replace('#', '')).toLowerCase();
  return raw === 'reuniao' || raw === 'agenda' || raw === 'pendencias' || raw === 'pc' || raw === 'memoria' ? raw : 'chat';
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
  // Acabou a ligação que estava gravando: encerra aquela reunião (a ata sai sozinha).
  const robo = useRobo(token, (r) => {
    if (DESKTOP === 'painel' && r.acao === 'encerrar' && r.reuniao) {
      window.dispatchEvent(new CustomEvent('robo:encerrar-reuniao', { detail: { reuniao: r.reuniao } }));
    }
  });
  const [tab, setTab] = useState<Tab>(initialTab);
  const largo = useLargo();
  // No painel largo, o humor dele fica à mostra embaixo do nome.
  const [humor, setHumor] = useState<EstadoDoMiro['humor']>(null);
  useEffect(() => {
    if (!largo) return;
    const ler = () => void lerEstado(token).then((e) => setHumor(e.humor)).catch(() => undefined);
    ler();
    const id = setInterval(ler, 60_000);
    return () => clearInterval(id);
  }, [largo, token]);
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
  const [voiceProvider, setVoiceProvider] = useState<'edge' | 'elevenlabs' | null>(null);
  const [push, setPush] = useState<PushState>(() => pushState());
  const [notice, setNotice] = useState('');
  const [convo, setConvo] = useState(false);
  const [cutucado, setCutucado] = useState(false);
  const [autoMeeting, setAutoMeeting] = useState(false);

  // No painel do computador: "Miro, grava a reunião" / "encerra a reunião" chegam por aqui.
  useEffect(() => {
    if (DESKTOP !== 'painel') return;
    desktop?.aoComando?.((acao) => {
      if (acao === 'reuniao:gravar') {
        setTab('reuniao');
        setAutoMeeting(true);
      } else if (acao === 'reuniao:encerrar') {
        window.dispatchEvent(new Event('robo:encerrar-reuniao'));
      }
    });
  }, []);
  const proximos = robo.agenda.filter((i) => i.end > now).length;

  useEffect(() => {
    void configureSpeech(token).then(setVoiceProvider);
    void refreshPush(token);
  }, [token]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(id);
  }, [notice]);

  const onBell = async () => {
    const st = pushState();
    if (st === 'needs-install') {
      setNotice('No iPhone: toque em Compartilhar → Adicionar à Tela de Início e abra o Miro por lá para ativar as notificações.');
      return;
    }
    if (st === 'unsupported') return setNotice('Este navegador não recebe notificações.');
    if (st === 'denied') return setNotice('As notificações estão bloqueadas: libere em Ajustes → Notificações → Miro.');
    try {
      if (st === 'default') {
        await enablePush(token);
        setPush('granted');
      }
      const sent = await testPush(token);
      setNotice(sent ? 'Notificações ativas — mandei uma de teste.' : 'Nenhum aparelho inscrito ainda.');
    } catch (err) {
      setPush(pushState());
      setNotice(`Não deu: ${(err as Error).message}`);
    }
  };

  // Lê em voz alta só o que o robô disser depois de ligar (não o histórico).
  useEffect(() => {
    if (convo) {
      // Na chamada quem fala é o próprio modo: marca tudo como já falado para não repetir ao sair.
      spokenUpTo.current = Date.now();
      return;
    }
    if (!speakOn || DESKTOP) return; // no computador quem fala é a bolha, não o painel
    const fresh = robo.messages.filter((m) => m.from === 'robot' && m.ts > spokenUpTo.current);
    if (!fresh.length) return;
    spokenUpTo.current = Math.max(...fresh.map((m) => m.ts));
    // Resposta a pergunta feita em outro aparelho: fica no chat, mas não fala aqui.
    const minhas = fresh.filter((m) => eParaMim(m) && !m.mudo);
    if (minhas.length) void speak(minhas[minhas.length - 1]!.text);
  }, [robo.messages, speakOn, convo]);

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
    if (on) {
      unlockAudio();
      void speak('Beleza, vou ler minhas respostas.');
    }
    else stopSpeaking();
  };

  let status: string;
  if (robo.conn !== 'open') status = 'reconectando…';
  else if (r?.thinking) status = 'pensando…';
  else if (r?.waiting_since) status = `esperando você ${ago(r.waiting_since, now)}`;
  else if (!r?.online) status = 'Miro desligado — o chat funciona igual';
  else status = 'na mesa, de olho em você';

  const face = r?.online ? r.face : r?.thinking ? 'thinking' : null;

  /** Tocou no robozinho: o da mesa acorda e dá um oi. */
  const acordarRobo = () => {
    setCutucado(true);
    setTimeout(() => setCutucado(false), 500);
    void fetch('/api/robot/acordar', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  };

  const avatar = (size: number) => (
    <button
      type="button"
      className={`robo-avatar ${cutucado ? 'robo-avatar--cutucado' : ''}`}
      onClick={acordarRobo}
      aria-label="Acordar o Miro"
      title="Acordar o Miro"
    >
      <RobotFace face={face} size={size} className={r?.online ? '' : 'face--offline'} />
    </button>
  );
  const statusClasse = `status ${robo.conn !== 'open' ? 'status--warn' : r?.waiting_since ? 'status--wait' : ''}`;

  const botoes = (
    <>
      {!DESKTOP && (
        <button
          type="button"
          className={`icon-btn ${push === 'granted' ? 'icon-btn--on' : ''}`}
          onClick={onBell}
          aria-label={push === 'granted' ? 'Notificações ativas — mandar teste' : 'Ativar notificações'}
          title={push === 'granted' ? 'Notificações ativas (toque para testar)' : 'Ativar notificações'}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2 2 0 0 0 4 0"
              fill={push === 'granted' ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="icon-btn"
        onClick={() => {
          // Este toque destrava o áudio E o microfone no iPhone: os dois só ligam dentro de um gesto.
          unlockAudio();
          void audioContext();
          setConvo(true);
        }}
        aria-label="Conversar por voz"
        title="Conversar por voz"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M6.6 10.8a12 12 0 0 0 5.6 5.6l1.9-1.9c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.4.6.6 0 1 .4 1 1V19c0 .6-.4 1-1 1A16 16 0 0 1 3 4c0-.6.4-1 1-1h3.1c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.4.1.4 0 .8-.3 1l-1.8 1.9Z"
            fill="currentColor"
          />
        </svg>
      </button>
      {speechSupported && !DESKTOP && (
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
    </>
  );

  const avisos = (
    <>
      {notice && (
        <div className="notice" role="status" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}
      {speakOn && voiceProvider === 'elevenlabs' && <p className="credit">Voz: ElevenLabs</p>}
    </>
  );

  const conteudo = (
    <>
      {tab === 'chat' && (
        <Chat
          token={token}
          messages={robo.messages}
          thinking={!!r?.thinking}
          online={robo.conn === 'open'}
          onSay={robo.say}
          onSendVoice={robo.sendVoice}
          onConfirm={robo.confirm}
        />
      )}
      {tab === 'agenda' && <Agenda items={robo.agenda} />}
      {tab === 'pendencias' && <Tasks token={token} />}
      {tab === 'pc' && <Computador token={token} />}
      {tab === 'memoria' && <Memoria token={token} />}
      {/* Sempre montada (só escondida): trocar de aba no meio da gravação matava a reunião. */}
      <div hidden={tab !== 'reuniao'}>
        <MeetingView token={token} autoStart={autoMeeting} onAutoStarted={() => setAutoMeeting(false)} />
      </div>

      {convo && (
        <VoiceConversation
          token={token}
          onClose={() => setConvo(false)}
          onStartMeeting={() => {
            setConvo(false);
            setAutoMeeting(true);
            setTab('reuniao');
          }}
        />
      )}
    </>
  );

  if (largo) {
    const aba = ABAS.find((a) => a.id === tab)!;
    return (
      <div className="app app--largo">
        <aside className="lado">
          <div className="lado__miro">
            {avatar(84)}
            <strong>Miro</strong>
            <span className={statusClasse}>{status}</span>
            {humor && (
              <span className="lado__humor" title={humor.descricao}>
                {humor.descricao.replace(/ \(.*$/, '')}
              </span>
            )}
          </div>
          <nav className="lado__nav" role="tablist" aria-orientation="vertical">
            {ABAS.map((a) => (
              <button key={a.id} role="tab" aria-selected={tab === a.id} className={tab === a.id ? 'on' : ''} onClick={() => setTab(a.id)}>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path d={a.icone} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {a.nome}
                {a.id === 'agenda' && proximos > 0 && <span className="tab-badge">{proximos}</span>}
              </button>
            ))}
          </nav>
          <div className="lado__botoes">{botoes}</div>
        </aside>

        <main className={`centro centro--${tab}`}>
          <header className="centro__topo">
            <h2>{aba.nome}</h2>
          </header>
          {avisos}
          {conteudo}
        </main>

        <Lateral token={token} agenda={robo.agenda} now={now} onAbrir={setTab} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="top">
        {avatar(52)}
        <div className="who">
          <strong>Miro</strong>
          <span className={statusClasse}>{status}</span>
        </div>
        {botoes}
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          Conversa
        </button>
        <button role="tab" aria-selected={tab === 'agenda'} className={tab === 'agenda' ? 'on' : ''} onClick={() => setTab('agenda')}>
          Agenda
          {proximos > 0 && <span className="tab-badge">{proximos}</span>}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'pendencias'}
          className={tab === 'pendencias' ? 'on' : ''}
          onClick={() => setTab('pendencias')}
        >
          Pendências
        </button>
        <button role="tab" aria-selected={tab === 'reuniao'} className={tab === 'reuniao' ? 'on' : ''} onClick={() => setTab('reuniao')}>
          Reunião
        </button>
        <button role="tab" aria-selected={tab === 'pc'} className={tab === 'pc' ? 'on' : ''} onClick={() => setTab('pc')} title="Voz, computadores e WhatsApp">
          Ajustes
        </button>
      </nav>

      {avisos}
      {conteudo}
    </div>
  );
}

/** ?convite=... — quem chegou pelo link só grava reunião, não entra no robô.
    Lido uma vez, fora do componente: assim os hooks abaixo rodam sempre na mesma ordem. */
const CONVITE = typeof location !== 'undefined' ? new URL(location.href).searchParams.get('convite') : null;

export function App() {
  const [token, setToken] = useState<string | null>(() => (CONVITE ? null : loadToken()));
  if (CONVITE) return <Guest token={CONVITE} />;

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
        closeMic(); // sair do app desliga o microfone (é o único lugar que desliga)
        saveToken(null);
        setToken(null);
      }}
    />
  );
}
