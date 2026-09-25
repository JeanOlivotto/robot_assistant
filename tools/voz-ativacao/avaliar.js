/*
 * Roda tiny, base e small nas amostras coletadas e compara: chamadas pegas, disparos à toa, tempo.
 * Uso: node avaliar.js [Nome]
 */
const fs = require('fs');
const sherpa = require('sherpa-onnx-node');
const { VOZ_DIR, chamou, whisper, MODELOS } = require('./comum');
const NOME = process.argv[2] || 'Miro';
const wavs = fs.readdirSync(VOZ_DIR).filter((f) => f.endsWith('.wav')).sort();
if (!wavs.length) {
  console.log(`nenhuma amostra em ${VOZ_DIR} — rode "node coleta.js" antes`);
  process.exit(1);
}
for (const tam of ['tiny', 'base', 'small']) {
  if (!fs.existsSync(`${MODELOS}/sherpa-onnx-whisper-${tam}`)) continue;
  const rec = whisper(sherpa, tam);
  let pegou = 0, sim = 0, falso = 0, nao = 0, ms = 0;
  const linhas = [];
  for (const f of wavs) {
    const w = sherpa.readWave(`${VOZ_DIR}/${f}`, false);
    const st = rec.createStream();
    st.acceptWaveform({ sampleRate: w.sampleRate, samples: w.samples });
    const a = Date.now();
    rec.decode(st);
    ms += Date.now() - a;
    const txt = rec.getResult(st).text.trim();
    const esperado = f.endsWith('-S.wav');
    const achou = chamou(txt, NOME);
    if (esperado) { sim++; if (achou) pegou++; } else { nao++; if (achou) falso++; }
    linhas.push(`  ${achou === esperado ? 'ok   ' : esperado ? 'PERDEU' : 'FALSO '} "${txt}"`);
  }
  console.log(`\nwhisper-${tam}: pegou ${pegou}/${sim} chamadas, ${falso}/${nao} disparos à toa, ${Math.round(ms / wavs.length)} ms por frase`);
  console.log(linhas.join('\n'));
}
