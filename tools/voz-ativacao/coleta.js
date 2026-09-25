/*
 * Coletor guiado: mostra uma frase, você fala, ele guarda o áudio (só nesta máquina, em
 * ~/.cache/robo-voz/amostras). Uso: node coleta.js [Nome]
 */
const fs = require('fs');
const sherpa = require('sherpa-onnx-node');
const { MODELOS, VOZ_DIR } = require('./comum');
const { ouvirMicrofone, detectorDeVoz } = require('./microfone');

const N = process.argv[2] || 'Miro';
const FRASES = [
  ['S', `${N}, grava a reunião.`],
  ['S', `Ei ${N}, o que eu tenho amanhã?`],
  ['S', `${N}, abre o painel.`],
  ['S', `${N}, para de falar.`],
  ['S', `${N}, gera o link da reunião.`],
  ['S', `Ô ${N}, que horas são?`],
  ['S', `${N}, me lembra de ligar pro Fábio.`],
  ['S', `${N}, esconde.`],
  ['N', 'Primeiro, vou terminar esse relatório.'],
  ['N', `Ontem eu falei com o ${N} sobre isso.`],
  ['N', 'Mira aquele ali, que coisa.'],
  ['N', 'Tá bom, depois a gente vê isso com calma.'],
];
fs.mkdirSync(VOZ_DIR, { recursive: true });
const vad = detectorDeVoz(sherpa, MODELOS, 0.6);
let i = 0;
const mostrar = () => i < FRASES.length && console.log(`\n[${i + 1}/${FRASES.length}] Fale agora:  "${FRASES[i][1]}"`);
let parar = () => {};
function guardar(samples) {
  const [tipo, frase] = FRASES[i];
  const f = `${VOZ_DIR}/${String(i).padStart(2, '0')}-${tipo}.wav`;
  sherpa.writeWave(f, { samples, sampleRate: 16000 });
  fs.writeFileSync(f.replace('.wav', '.txt'), frase);
  console.log(`   ok (${(samples.length / 16000).toFixed(1)} s)`);
  if (++i >= FRASES.length) {
    console.log(`\nPronto! ${FRASES.length} frases guardadas em ${VOZ_DIR}`);
    parar();
    process.exit(0);
  }
  setTimeout(mostrar, 400);
}
console.log('Fale cada frase no fone, do seu jeito normal, e espere o "ok" antes da próxima.');
mostrar();
parar = ouvirMicrofone((bloco) => {
  vad.acceptWaveform(bloco);
  while (!vad.isEmpty()) {
    const seg = vad.front(false);
    vad.pop();
    if (i < FRASES.length && seg.samples.length > 16000 * 0.4) guardar(Float32Array.from(seg.samples));
  }
});
setTimeout(() => {
  console.log('\nTempo esgotado (3 min).');
  process.exit(0);
}, 180_000);
