/**
 * Lê as respostas do robô em voz alta. Com voz no servidor (edge-tts/ElevenLabs), usa ela;
 * sem ela (ou com a cota do mês esgotada), cai para a voz do aparelho — de preferência masculina.
 *
 * A fala sai por frases: o robô começa a falar assim que a PRIMEIRA frase fica pronta, enquanto
 * a seguinte já está sendo gerada. É o que tira aquele silêncio comprido antes de ele responder.
 */

let token = '';
let serverVoice: 'edge' | 'elevenlabs' | null = null;
let deviceVoice: SpeechSynthesisVoice | null = null;
/** Corta a reprodução no meio (interrupção) sem deixar ninguém esperando para sempre. */
let cutPlayback: (() => void) | null = null;

/* Um único <audio>: no iPhone, depois de destravado por um toque, ele pode tocar sozinho. */
const player = typeof Audio !== 'undefined' ? new Audio() : null;
/** WAV mudo de 50 ms, gerado aqui — tocar ele num toque é o que destrava o áudio no iPhone. */
function silentWav(): string {
  const samples = 400; // 8 kHz, 16 bits, mono
  const buf = new DataView(new ArrayBuffer(44 + samples * 2));
  const tag = (o: number, t: string) => [...t].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  buf.setUint32(4, 36 + samples * 2, true);
  tag(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, 8000, true);
  buf.setUint32(28, 16000, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  tag(36, 'data');
  buf.setUint32(40, samples * 2, true);
  let bin = '';
  new Uint8Array(buf.buffer).forEach((x) => (bin += String.fromCharCode(x)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export const speechSupported = typeof window !== 'undefined' && ('speechSynthesis' in window || !!player);

function pickDeviceVoice(): SpeechSynthesisVoice | null {
  const pt = window.speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith('pt'));
  const br = pt.filter((v) => v.lang.replace('_', '-') === 'pt-BR');
  const male = (list: SpeechSynthesisVoice[]) => list.find((v) => /felipe|daniel|antonio|male|mascul/i.test(v.name));
  return male(br) ?? br[0] ?? male(pt) ?? pt[0] ?? null;
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    deviceVoice = pickDeviceVoice();
  };
}

/** Descobre se o servidor tem voz própria. Chamar uma vez ao abrir o app. */
export async function configureSpeech(appToken: string): Promise<'edge' | 'elevenlabs' | null> {
  token = appToken;
  try {
    const res = await fetch('/api/tts/status', { headers: { Authorization: `Bearer ${token}` } });
    serverVoice = res.ok ? ((await res.json()) as { provider: 'edge' | 'elevenlabs' | null }).provider : null;
  } catch {
    serverVoice = null;
  }
  return serverVoice;
}

/** Chamar dentro de um toque: destrava o áudio no iPhone. */
export function unlockAudio(): void {
  if (!player) return;
  player.src = silentWav();
  void player.play().catch(() => undefined);
}

function forSpeech(raw: string): string {
  return raw.replace(/\p{Extended_Pictographic}|️|‍/gu, '').trim();
}

/** Quebra a resposta em pedaços que valem uma ida ao servidor: frases, sem picotar demais. */
function phrases(text: string): string[] {
  const parts = text
    .replace(/([.!?…])\s+/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    // Pedaço curto demais soa picado na voz sintética: gruda no anterior.
    if (last && (last.length < 30 || part.length < 16) && last.length + part.length <= 160) out[out.length - 1] = `${last} ${part}`;
    else out.push(part);
  }
  return out;
}

async function fetchSpeech(text: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null; // sem servidor (ou cancelado): quem chamou decide o que fazer
  }
}

function playUrl(url: string, onStart?: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!player) return resolve();
    const end = () => {
      cutPlayback = null;
      player.onended = null;
      player.onerror = null;
      URL.revokeObjectURL(url);
      resolve();
    };
    cutPlayback = end;
    player.onended = end;
    player.onerror = end;
    player.src = url;
    void player
      .play()
      .then(() => onStart?.())
      .catch(() => end());
  });
}

function deviceSay(text: string, onStart?: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    deviceVoice ??= pickDeviceVoice();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-BR';
    if (deviceVoice) u.voice = deviceVoice;
    const end = () => {
      cutPlayback = null;
      resolve();
    };
    cutPlayback = end;
    u.onend = end;
    u.onerror = end;
    u.onstart = () => onStart?.();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

export interface Speaking {
  /** Resolve quando a fala termina — ou na hora, se for interrompida. */
  done: Promise<void>;
  /** Cala a boca agora (você falou por cima). */
  stop(): void;
}

/**
 * Fala o texto e devolve o controle: `done` para esperar o fim, `stop()` para cortar no meio.
 * Enquanto uma frase toca, a próxima já está sendo gerada no servidor.
 *
 * `onStart` avisa quando o som realmente sai do alto-falante (não quando a fala foi pedida) —
 * é por esse aviso que o modo chamada só então passa a escutar quem fala por cima.
 */
export function speakStream(raw: string, onStart?: () => void): Speaking {
  const text = forSpeech(raw);
  const parts = phrases(text);
  const fetches = new AbortController();
  let stopped = false;

  let started = false;
  const announce = () => {
    if (started) return;
    started = true;
    onStart?.();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    fetches.abort();
    stopSpeaking();
  };

  const done = (async () => {
    if (!parts.length) return;
    if (serverVoice && player) {
      let next: Promise<string | null> | null = fetchSpeech(parts[0]!, fetches.signal);
      for (let i = 0; i < parts.length && !stopped; i++) {
        const current = next;
        next = i + 1 < parts.length ? fetchSpeech(parts[i + 1]!, fetches.signal) : null;
        const url = current ? await current : null;
        if (stopped) {
          if (url) URL.revokeObjectURL(url);
          break;
        }
        if (!url) {
          // Servidor de voz caiu no meio: termina o resto com a voz do aparelho.
          fetches.abort();
          await deviceSay(parts.slice(i).join(' '), announce);
          return;
        }
        await playUrl(url, announce);
      }
      return;
    }
    for (const part of parts) {
      if (stopped) return;
      await deviceSay(part, announce);
    }
  })();

  return { done, stop };
}

export async function speak(raw: string): Promise<void> {
  await speakStream(raw).done;
}

/** Como speak(), mas só volta quando a fala TERMINA. */
export async function speakUntilDone(raw: string): Promise<void> {
  await speakStream(raw).done;
}

export function stopSpeaking(): void {
  player?.pause();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  cutPlayback?.(); // quem estava esperando o fim não fica pendurado
}
