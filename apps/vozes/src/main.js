/*
 * Vozes: recebe o áudio de uma reunião e devolve quem falou quando ("pessoa 1 de 0:00 a 0:12…").
 * Não sabe QUEM é cada pessoa — só separa as vozes. Roda como container próprio, ao lado do
 * gateway e só na rede interna: se o processamento pesar ou travar, o chat e o robô seguem.
 *
 * Modelos (sherpa-onnx, CPU): segmentação pyannote 3.0 + assinatura de voz 3D-Speaker ERes2Net.
 * No teste de 4 vozes do próprio sherpa, com limiar 0,9, acertou todos os trechos.
 *
 *   POST /diarizar[?limiar=0.9&pessoas=N]   corpo: PCM s16le, 16 kHz, mono
 *        → turnos de fala + a assinatura de voz de cada pessoa (para o banco de vozes do gateway)
 *   POST /assinatura                        corpo: idem → assinatura de um áudio de uma pessoa só
 *   GET  /saude
 *
 * Assinatura = vetor de 512 números que resume o timbre. Quem compara com as vozes conhecidas
 * (e guarda os nomes) é o gateway; este serviço não guarda nada.
 */
import { createServer } from 'node:http';
import sherpa from 'sherpa-onnx-node';

const PORT = Number(process.env.PORT ?? 8090);
const MODELS = process.env.VOZES_MODELS ?? '/models';
const LIMIAR = Number(process.env.VOZES_LIMIAR ?? 0.9);
const THREADS = Number(process.env.VOZES_THREADS ?? 2);
const SAMPLE_RATE = 16000;
const MAX_SECONDS = 4 * 3600; // reunião de até 4 h
const MAX_BYTES = MAX_SECONDS * SAMPLE_RATE * 2;

const sd = new sherpa.OfflineSpeakerDiarization({
  segmentation: { pyannote: { model: `${MODELS}/segmentation.onnx` }, numThreads: THREADS },
  embedding: { model: `${MODELS}/embedding.onnx`, numThreads: THREADS },
  clustering: { numClusters: -1, threshold: LIMIAR },
  minDurationOn: 0.3,
  minDurationOff: 0.5,
});
if (sd.sampleRate !== SAMPLE_RATE) throw new Error(`modelo espera ${sd.sampleRate} Hz`);
const extrator = new sherpa.SpeakerEmbeddingExtractor({ model: `${MODELS}/embedding.onnx`, numThreads: THREADS });

/* Até 60 s de fala por pessoa bastam para a assinatura; mais que isso só gasta CPU. */
const ASSINATURA_MAX_S = 60;
const TRECHO_MIN_S = 0.8; // pedacinhos curtos demais (um "é") atrapalham mais que ajudam

function assinar(samples) {
  const st = extrator.createStream();
  st.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  st.inputFinished();
  if (!extrator.isReady(st)) return null;
  return Array.from(extrator.compute(st), (x) => +x.toFixed(5));
}

function paraFloat(pcm) {
  // Int16 → Float32 em [-1, 1]. Copia antes: o Buffer pode não estar alinhado em 2 bytes.
  const s16 = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)));
  const samples = new Float32Array(s16.length);
  for (let i = 0; i < s16.length; i++) samples[i] = s16[i] / 32768;
  return samples;
}

/* CPU é uma só: um áudio por vez, os outros esperam na fila. */
let fila = Promise.resolve();

function diarizar(pcm, limiar, pessoas) {
  const samples = paraFloat(pcm);

  sd.setConfig({ clustering: { numClusters: pessoas > 0 ? pessoas : -1, threshold: limiar } });
  const t0 = Date.now();
  const segs = sd.process(samples);

  // Renumera na ordem em que cada voz aparece: "pessoa 1" é quem falou primeiro.
  const ordem = new Map();
  const trechos = segs.map((s) => {
    if (!ordem.has(s.speaker)) ordem.set(s.speaker, ordem.size + 1);
    return { inicio: +s.start.toFixed(2), fim: +s.end.toFixed(2), pessoa: ordem.get(s.speaker) };
  });

  // A assinatura de cada pessoa sai dos trechos dela, juntos (até 60 s).
  const assinaturas = [];
  for (let p = 1; p <= ordem.size; p++) {
    const pedacos = [];
    let total = 0;
    for (const t of trechos) {
      if (t.pessoa !== p || t.fim - t.inicio < TRECHO_MIN_S || total >= ASSINATURA_MAX_S) continue;
      const fim = Math.min(t.fim, t.inicio + (ASSINATURA_MAX_S - total));
      pedacos.push(samples.subarray(Math.floor(t.inicio * SAMPLE_RATE), Math.floor(fim * SAMPLE_RATE)));
      total += fim - t.inicio;
    }
    if (total < 1) continue; // falou pouco demais para dar uma assinatura confiável
    const junto = new Float32Array(pedacos.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of pedacos) {
      junto.set(x, o);
      o += x.length;
    }
    const embedding = assinar(junto);
    if (embedding) assinaturas.push({ pessoa: p, segundos: +total.toFixed(1), embedding });
  }
  return { segundos: +(samples.length / SAMPLE_RATE).toFixed(1), pessoas: ordem.size, trechos, assinaturas, ms: Date.now() - t0 };
}

function responder(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://vozes');
  if (req.method === 'GET' && url.pathname === '/saude') return responder(res, 200, { ok: true, limiar: LIMIAR });
  const rota = url.pathname;
  if (req.method !== 'POST' || (rota !== '/diarizar' && rota !== '/assinatura')) return responder(res, 404, { erro: 'rota não existe' });

  const partes = [];
  let total = 0;
  req.on('data', (c) => {
    total += c.length;
    if (total > MAX_BYTES) {
      responder(res, 413, { erro: `áudio maior que ${MAX_SECONDS / 3600} h` });
      req.destroy();
    } else partes.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    const pcm = Buffer.concat(partes);
    if (pcm.length < SAMPLE_RATE * 2) return responder(res, 400, { erro: 'áudio vazio ou menor que 1 s' });
    const limiar = Number(url.searchParams.get('limiar') ?? LIMIAR);
    const pessoas = Number(url.searchParams.get('pessoas') ?? 0);
    fila = fila.then(() => {
      try {
        if (rota === '/assinatura') {
          const embedding = assinar(paraFloat(pcm));
          if (!embedding) return responder(res, 422, { erro: 'áudio curto demais para a assinatura' });
          return responder(res, 200, { segundos: +(pcm.length / (SAMPLE_RATE * 2)).toFixed(1), embedding });
        }
        const r = diarizar(pcm, limiar, pessoas);
        console.log(`[vozes] ${r.segundos} s de áudio → ${r.pessoas} voz(es), ${r.trechos.length} trechos em ${r.ms} ms`);
        responder(res, 200, r);
      } catch (err) {
        console.error(`[vozes] falhou: ${err.message}`);
        responder(res, 500, { erro: err.message });
      }
    });
  });
}).listen(PORT, () => console.log(`[vozes] ouvindo em :${PORT} (limiar ${LIMIAR}, ${THREADS} threads)`));
