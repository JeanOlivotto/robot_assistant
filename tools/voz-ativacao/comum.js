/* O que os scripts do protótipo compartilham: onde ficam os modelos e como saber se chamaram o nome. */
const os = require('os');
const path = require('path');

/** Fora do /tmp (que some ao reiniciar) e fora do git (são centenas de MB). */
const MODELOS = process.env.ROBO_VOZ_MODELOS || path.join(os.homedir(), '.cache', 'robo-voz');
const VOZ_DIR = process.env.ROBO_VOZ_AMOSTRAS || path.join(os.homedir(), '.cache', 'robo-voz', 'amostras');

const norma = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

function dist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** A frase começa com o nome (depois de um "ei/ô/oi" opcional, grudado ou não), com até 1 letra de diferença? */
function chamou(texto, nome, extras = []) {
  const p = norma(texto).split(' ');
  const n = norma(nome);
  let w = p[0] ?? '';
  if (['ei', 'o', 'oi', 'e', 'hey', 'ai'].includes(w) && p.length > 1) w = p[1];
  else if (/^(ei|oi|o)/.test(w) && w.length > n.length) w = w.replace(/^(ei|oi|o)/, '');
  if (extras.includes(w)) return true;
  return w.length >= n.length - 1 && dist(w, n) <= 1;
}

function whisper(sherpa, tam) {
  const d = path.join(MODELOS, `sherpa-onnx-whisper-${tam}`);
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: `${d}/${tam}-encoder.int8.onnx`, decoder: `${d}/${tam}-decoder.int8.onnx`, language: 'pt', task: 'transcribe' },
      tokens: `${d}/${tam}-tokens.txt`,
      numThreads: 2,
    },
  });
}

module.exports = { MODELOS, VOZ_DIR, norma, dist, chamou, whisper };
