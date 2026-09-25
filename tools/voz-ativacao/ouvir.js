/*
 * Ouvinte ao vivo: microfone → detector de voz → Whisper só nas falas curtas → chamou o nome?
 * Uso: node ouvir.js [Nome] [segundos] [tiny|base|small] [--mostrar]
 */
const sherpa = require('sherpa-onnx-node');
const { MODELOS, chamou, whisper } = require('./comum');
const { ouvirMicrofone, detectorDeVoz } = require('./microfone');

const NOME = process.argv[2] || 'Miro';
const SEG = Number(process.argv[3] || 60);
const TAM = ['tiny', 'base', 'small'].includes(process.argv[4]) ? process.argv[4] : 'tiny';
const MOSTRAR = process.argv.includes('--mostrar');
const vad = detectorDeVoz(sherpa, MODELOS, 0.4);
const rec = whisper(sherpa, TAM);
let falas = 0, chamadas = 0, whisperMs = 0;
const t0 = Date.now(), cpu0 = process.cpuUsage();
const parar = ouvirMicrofone((bloco) => {
  vad.acceptWaveform(bloco);
  while (!vad.isEmpty()) {
    const seg = vad.front(false);
    vad.pop();
    if (seg.samples.length / 16000 > 6) continue; // comando é frase curta: fala longa nem passa pelo Whisper
    falas++;
    const st = rec.createStream();
    st.acceptWaveform({ sampleRate: 16000, samples: seg.samples });
    const a = Date.now();
    rec.decode(st);
    whisperMs += Date.now() - a;
    const txt = rec.getResult(st).text.trim();
    const sim = chamou(txt, NOME);
    if (sim) chamadas++;
    if (MOSTRAR) console.log(`${sim ? '>>> CHAMOU' : '   ignorou'} (${Date.now() - a} ms) "${txt}"`);
  }
});
setTimeout(() => {
  parar();
  const c = process.cpuUsage(cpu0), el = (Date.now() - t0) / 1000;
  console.log(`\n${el.toFixed(0)} s ouvindo (whisper-${TAM}) | ${falas} fala(s), ${chamadas} chamada(s) | ${falas ? Math.round(whisperMs / falas) : 0} ms/fala | CPU ${(((c.user + c.system) / 1e6 / el) * 100).toFixed(1)}% de um núcleo`);
  process.exit(0);
}, SEG * 1000);
