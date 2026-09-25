/*
 * O ouvido do "Miro, …". Roda no PC e deixa passar quase nada: o microfone chega da bolha (o
 * Chromium capta — no Linux e no Windows), o detector de voz separa as falas, e o Whisper tiny
 * transcreve só as curtas. Se a frase nem lembra o nome, morre aqui. Se lembra (o tiny ouvia o
 * "Miro" do dono como "primeiro"), vira CANDIDATA e vai para o servidor, onde o Whisper grande
 * confirma. Protótipo em tools/voz-ativacao; medido: 1,6–6% de CPU de um núcleo, ~150 ms por fala.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);

const RATE = 16000;
const JANELA = 512; // o que o detector de voz (Silero) espera por vez
/* Com música ou TV ao fundo o detector junta tudo num trecho longo (até 12 s): antes era jogado
   fora inteiro, e o "Miro" no meio ia junto. Agora passa pelo Whisper do mesmo jeito. */
const FALA_MAX_S = 13;
const FALA_MIN_S = 0.35;

/* Arquivo por arquivo (sem .tar.bz2, que o Windows não abre direito). ~104 MB, uma vez só. */
const HF = 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main';
const ARQUIVOS = {
  'silero_vad.onnx': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  'tiny-encoder.int8.onnx': `${HF}/tiny-encoder.int8.onnx`,
  'tiny-decoder.int8.onnx': `${HF}/tiny-decoder.int8.onnx`,
  'tiny-tokens.txt': `${HF}/tiny-tokens.txt`,
};

/* O tiny ouve o "Miro" do dono de vários jeitos; estas contam como "pode ser" (o servidor decide). */
const SUSPEITAS = ['primeiro', 'primeira', 'imiro', 'emiro', 'omiro', 'eimiro'];
const CHAMAMENTOS = ['ei', 'o', 'oi', 'e', 'hey', 'ai', 'eai', 'fala', 'ok', 'okay', 'ola', 'alo', 'opa', 'beleza', 'bom', 'dia', 'boa', 'tarde', 'noite', 'escuta', 'olha', 'entao'];
/* Palavras comuns a duas letras do nome: começar frase com elas é falar, não chamar ("Muito obrigado"). */
const COMUNS = ['muito', 'mesmo', 'minha', 'menos', 'mundo', 'meio', 'mais', 'ruim', 'isso', 'nisso', 'disso', 'aqui', 'cara', 'caro'];

const norma = (t) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function dist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function parece(w, n) {
  if (!w || COMUNS.includes(w)) return false;
  const sem = w.replace(/^(ei|oi|o|e|a)(?=.{3,})/, '');
  return SUSPEITAS.includes(w) || dist(w, n) <= 2 || dist(sem, n) <= 1;
}

/**
 * Filtro frouxo de propósito: melhor mandar uma a mais para o servidor (que decide com o Whisper
 * grande) do que perder o chamado. Olha o começo de cada frase (depois de "ei", "ok", "beleza"…)
 * e a última palavra ("que horas são, Miro?").
 */
export function podeSerChamado(texto, nome) {
  const n = norma(nome);
  if (!n) return false;
  const frases = String(texto)
    .replace(/[[(][^\])]*[\])]/g, ' ') // "[música]" é anotação, não fala
    .split(/[.!?]+/)
    .map((f) => norma(f).split(' ').filter(Boolean))
    .filter((p) => p.length);
  for (const palavras of frases) {
    let i = 0;
    while (i < palavras.length - 1 && i < 3 && CHAMAMENTOS.includes(palavras[i])) i++;
    if (palavras.slice(i, i + 2).some((w) => parece(w, n))) return true;
  }
  const ultima = frases.at(-1)?.at(-1);
  return parece(ultima, n);
}

/** PCM float → WAV 16 bits (o que o /api/voice/chamado recebe). */
function wav(samples) {
  const v = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const tag = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(v.buffer);
}

export class Ouvinte {
  /**
   * @param {{ pasta: string, aoCandidato(c: { wav: Uint8Array, texto: string }): void, aoEstado?(e: string): void }} o
   */
  constructor(o) {
    this.pasta = o.pasta;
    this.aoCandidato = o.aoCandidato;
    this.aoEstado = o.aoEstado ?? (() => {});
    this.nome = 'Miro';
    this.vad = null;
    this.rec = null;
    this.resto = new Float32Array(0);
    this.preparando = null;
    this.atentoAte = 0;
  }

  /**
   * Conversa em andamento: por `ms`, a próxima fala vale como comando mesmo sem o nome (depois de
   * um "Miro?" sozinho, ou quando ele fez uma pergunta). Antes era preciso chamar de novo.
   */
  atento(ms) {
    this.atentoAte = Date.now() + Math.max(0, Math.min(ms, 20_000));
  }

  get pronto() {
    return !!this.vad;
  }

  /** Baixa o que faltar e carrega os modelos. Pode chamar várias vezes: prepara uma só. */
  preparar() {
    this.preparando ??= this.#preparar().catch((err) => {
      this.preparando = null;
      this.aoEstado(`erro: ${err.message}`);
      throw err;
    });
    return this.preparando;
  }

  async #preparar() {
    mkdirSync(this.pasta, { recursive: true });
    for (const [arq, url] of Object.entries(ARQUIVOS)) {
      const destino = join(this.pasta, arq);
      if (existsSync(destino)) continue;
      this.aoEstado(`baixando ${arq}`);
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`não baixei ${arq} (HTTP ${res.status})`);
      const parcial = `${destino}.parcial`;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(parcial));
      renameSync(parcial, destino); // só vale inteiro: download pela metade não fica
    }
    const sherpa = require('sherpa-onnx-node');
    this.sherpa = sherpa;
    this.vad = new sherpa.Vad(
      {
        sileroVad: { model: join(this.pasta, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, maxSpeechDuration: 12, windowSize: JANELA },
        sampleRate: RATE,
        numThreads: 1,
      },
      60,
    );
    this.rec = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: {
        whisper: { encoder: join(this.pasta, 'tiny-encoder.int8.onnx'), decoder: join(this.pasta, 'tiny-decoder.int8.onnx'), language: 'pt', task: 'transcribe' },
        tokens: join(this.pasta, 'tiny-tokens.txt'),
        numThreads: 2,
      },
    });
    this.aoEstado('pronto');
  }

  /** Apaga os modelos baixados (para baixar de novo, se algum vier estragado). */
  esquecerModelos() {
    rmSync(this.pasta, { recursive: true, force: true });
    this.vad = this.rec = null;
    this.preparando = null;
  }

  /** Áudio do microfone (16 kHz, float) em pedaços de qualquer tamanho. */
  alimentar(amostras) {
    if (!this.vad) return;
    const tudo = new Float32Array(this.resto.length + amostras.length);
    tudo.set(this.resto);
    tudo.set(amostras, this.resto.length);
    let i = 0;
    for (; i + JANELA <= tudo.length; i += JANELA) this.vad.acceptWaveform(tudo.subarray(i, i + JANELA));
    this.resto = tudo.slice(i);
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false); // false: sem "external buffer", que o Electron recusa
      this.vad.pop();
      this.#fala(Float32Array.from(seg.samples));
    }
  }

  #fala(samples) {
    const dur = samples.length / RATE;
    if (dur < FALA_MIN_S) return;
    // Esperando a continuação: a frase inteira vai para o servidor, sem filtro de nome (uma só).
    if (Date.now() < this.atentoAte && dur <= 15) {
      this.atentoAte = 0;
      console.log(`${new Date().toLocaleTimeString('pt-BR')} [ouvido] continuação de ${dur.toFixed(1)} s → servidor`);
      this.aoCandidato({ wav: wav(samples), texto: '', seguimento: true });
      return;
    }
    if (dur > FALA_MAX_S) return void console.log(`${new Date().toLocaleTimeString('pt-BR')} [ouvido] fala de ${dur.toFixed(1)} s: longa demais, ignorada`);
    const st = this.rec.createStream();
    st.acceptWaveform({ sampleRate: RATE, samples });
    this.rec.decode(st);
    const texto = this.rec.getResult(st).text.trim();
    const candidata = podeSerChamado(texto, this.nome);
    // Fica só no log local (robo.log): é o que permite entender um chamado que ele não atendeu.
    console.log(`${new Date().toLocaleTimeString('pt-BR')} [ouvido] fala de ${dur.toFixed(1)} s: "${texto}" → ${candidata ? 'candidata' : 'descartada'}`);
    if (candidata) this.aoCandidato({ wav: wav(samples), texto });
  }
}
