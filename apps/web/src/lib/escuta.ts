/**
 * O microfone do "Miro, …" no app do computador: capta sem parar, em 16 kHz, e entrega pedaços
 * de áudio para o ouvido (processo principal do Electron), que decide o que é fala e o que é o
 * nome. Nada aqui sai do computador — quem manda para o servidor é a bolha, e só as candidatas.
 */
import { acquireMic, audioContext, releaseMic } from './mic';

const RATE = 16000;

const WORKLET = `
class RoboEscuta extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.buf.push(new Float32Array(ch)); this.n += ch.length;
      if (this.n >= 2048) {
        const out = new Float32Array(this.n); let o = 0;
        for (const p of this.buf) { out.set(p, o); o += p.length; }
        this.buf = []; this.n = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('robo-escuta', RoboEscuta);
`;

/** Liga a escuta; devolve a função que desliga (e devolve o microfone ao app). */
export async function escutar(entregar: (amostras: Float32Array) => void): Promise<() => void> {
  const stream = await acquireMic();
  const ctx = await audioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'robo-escuta');
  const mudo = ctx.createGain();
  mudo.gain.value = 0; // o worklet só roda ligado na saída — mas nada é tocado
  src.connect(node);
  node.connect(mudo);
  mudo.connect(ctx.destination);

  let pos = 0; // reamostragem: a placa nem sempre entrega 16 kHz
  const passo = ctx.sampleRate / RATE;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const src16 = e.data;
    if (Math.abs(passo - 1) < 0.001) return entregar(src16);
    const out = new Float32Array(Math.ceil((src16.length - pos) / passo) + 1);
    let n = 0;
    let p = pos;
    for (; p < src16.length; p += passo) {
      const i = Math.floor(p);
      const a = src16[i] ?? 0;
      const b = src16[i + 1] ?? a;
      out[n++] = a + (b - a) * (p - i);
    }
    pos = p - src16.length;
    entregar(out.subarray(0, n));
  };

  return () => {
    node.port.onmessage = null;
    try {
      src.disconnect();
      node.disconnect();
      mudo.disconnect();
    } catch {
      /* já estava solto */
    }
    releaseMic();
  };
}
