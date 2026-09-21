/**
 * O microfone do app, um só. A permissão é pedida UMA vez por sessão do app: depois disso o
 * stream nunca é destruído, então abrir outra chamada, mandar um áudio no chat ou gravar uma
 * reunião não pergunta nada de novo. Quando ninguém está usando, os canais ficam mudos
 * (`enabled = false`) — o microfone segue aberto, mas não capta nada.
 *
 * Único jeito de a pergunta voltar: recarregar a página (aí o navegador decide se lembra da
 * permissão) ou sair pelo botão Sair, que desliga o microfone de propósito.
 */

const CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

let stream: MediaStream | null = null;
let opening: Promise<MediaStream> | null = null;
let users = 0;
let ctx: AudioContext | null = null;

export const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

function alive(s: MediaStream | null): s is MediaStream {
  return !!s && s.getAudioTracks().some((t) => t.readyState === 'live');
}

/** Muda/desmuda sem fechar nada: é o que substitui o velho "desligar quando ninguém usa". */
function mute(on: boolean): void {
  stream?.getAudioTracks().forEach((t) => (t.enabled = !on));
}

/** Pega o microfone (pedindo permissão só na primeira vez). Sempre devolva com releaseMic(). */
export async function acquireMic(): Promise<MediaStream> {
  if (!micSupported) throw new Error('este navegador não grava áudio');
  if (alive(stream)) {
    users += 1;
    mute(false);
    return stream;
  }
  stream = null;
  // Vários pedidos ao mesmo tempo esperam a MESMA permissão — o contador só sobe se ela vier.
  opening ??= navigator.mediaDevices.getUserMedia(CONSTRAINTS).finally(() => {
    opening = null;
  });
  const granted = await opening;
  stream = granted;
  // O sistema pode encerrar o microfone sozinho (aba em segundo plano no iPhone, outro app
  // tomando o aparelho): aí a referência é largada e o próximo uso pede de novo.
  for (const track of granted.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (stream === granted) stream = null;
    });
  }
  users += 1;
  mute(false);
  return granted;
}

/** Devolve o microfone. Ele continua aberto (e mudo), pronto para o próximo uso sem perguntar nada. */
export function releaseMic(): void {
  users = Math.max(0, users - 1);
  if (users === 0) mute(true);
}

/** Desliga de verdade e apaga a luzinha de "gravando" — só ao sair do app. */
export function closeMic(): void {
  users = 0;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

/**
 * O AudioContext do app, também um só: criar e fechar um a cada turno custa caro e,
 * no iPhone, às vezes nem volta a funcionar.
 */
export async function audioContext(): Promise<AudioContext> {
  if (!ctx || ctx.state === 'closed') {
    try {
      ctx = new AudioContext({ sampleRate: 16000 }); // já na taxa que o servidor transcreve
    } catch {
      ctx = new AudioContext(); // navegador que não deixa escolher: reamostramos depois
    }
  }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  return ctx;
}
