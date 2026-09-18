/**
 * Lê as respostas do robô em voz alta. Com voz no servidor (ElevenLabs), usa ela;
 * sem ela (ou com a cota do mês esgotada), cai para a voz do aparelho — de preferência masculina.
 */

let token = '';
let serverVoice: 'elevenlabs' | null = null;
let deviceVoice: SpeechSynthesisVoice | null = null;

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
export async function configureSpeech(appToken: string): Promise<'elevenlabs' | null> {
  token = appToken;
  try {
    const res = await fetch('/api/tts/status', { headers: { Authorization: `Bearer ${token}` } });
    serverVoice = res.ok ? ((await res.json()) as { provider: 'elevenlabs' | null }).provider : null;
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

function speakWithDevice(text: string): void {
  if (!('speechSynthesis' in window)) return;
  deviceVoice ??= pickDeviceVoice();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pt-BR';
  if (deviceVoice) u.voice = deviceVoice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

export async function speak(raw: string): Promise<void> {
  const text = raw.replace(/\p{Extended_Pictographic}|️|‍/gu, '').trim();
  if (!text) return;
  if (serverVoice && player) {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        player.onended = () => URL.revokeObjectURL(url);
        player.src = url;
        await player.play();
        return;
      }
    } catch {
      /* cai para a voz do aparelho */
    }
  }
  speakWithDevice(text);
}

export function stopSpeaking(): void {
  player?.pause();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
