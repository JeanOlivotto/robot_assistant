/* Baixa o detector de voz e os Whisper tiny/base/small para ~/.cache/robo-voz (uma vez só). */
const { execSync } = require('child_process');
const fs = require('fs');
const { MODELOS } = require('./comum');
const B = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
fs.mkdirSync(MODELOS, { recursive: true });
const tamanhos = process.argv.slice(2).length ? process.argv.slice(2) : ['tiny', 'base', 'small'];
if (!fs.existsSync(`${MODELOS}/silero_vad.onnx`)) execSync(`curl -fsSL -o "${MODELOS}/silero_vad.onnx" ${B}/silero_vad.onnx`, { stdio: 'inherit' });
for (const t of tamanhos) {
  if (fs.existsSync(`${MODELOS}/sherpa-onnx-whisper-${t}`)) continue;
  console.log(`baixando whisper-${t}…`);
  execSync(`curl -fsSL ${B}/sherpa-onnx-whisper-${t}.tar.bz2 | tar xj -C "${MODELOS}"`, { stdio: 'inherit', shell: '/bin/sh' });
  // só os int8 ficam: os float ocupam o dobro e o protótipo não usa
  for (const f of fs.readdirSync(`${MODELOS}/sherpa-onnx-whisper-${t}`)) if (/^(tiny|base|small)-(en|de)coder\.onnx$/.test(f) || f === 'test_wavs') fs.rmSync(`${MODELOS}/sherpa-onnx-whisper-${t}/${f}`, { recursive: true, force: true });
}
console.log(`modelos em ${MODELOS}`);
