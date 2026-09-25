/* Microfone em PCM 16 kHz para o protótipo (Linux, via parec). No app, quem capta é o Chromium. */
const { spawn } = require('child_process');

/** Chama `cb(Float32Array)` com blocos de 512 amostras; devolve uma função para parar. */
function ouvirMicrofone(cb) {
  const mic = spawn('parec', ['--format=s16le', '--rate=16000', '--channels=1', '--latency-msec=40']);
  let resto = Buffer.alloc(0);
  mic.stdout.on('data', (b) => {
    b = Buffer.concat([resto, b]);
    const n = Math.floor(b.length / 2) - (Math.floor(b.length / 2) % 512);
    const s16 = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 2));
    resto = b.subarray(n * 2);
    for (let k = 0; k < n; k += 512) {
      const f = new Float32Array(512);
      for (let j = 0; j < 512; j++) f[j] = s16[k + j] / 32768;
      cb(f);
    }
  });
  mic.on('error', (e) => {
    console.error(`não consegui abrir o microfone (parec): ${e.message}`);
    process.exit(1);
  });
  return () => mic.kill();
}

function detectorDeVoz(sherpa, MODELOS, silencio = 0.5) {
  return new sherpa.Vad(
    { sileroVad: { model: `${MODELOS}/silero_vad.onnx`, threshold: 0.5, minSilenceDuration: silencio, minSpeechDuration: 0.25, maxSpeechDuration: 8, windowSize: 512 }, sampleRate: 16000, numThreads: 1 },
    60,
  );
}

module.exports = { ouvirMicrofone, detectorDeVoz };
