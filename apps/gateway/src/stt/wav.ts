/** PCM de um WAV 16 kHz, mono, 16 bits — ou null se o arquivo não for exatamente isso. */
export function pcmFromWav(buf: Buffer): Buffer | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let fmtOk = false;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      fmtOk = format === 1 && channels === 1 && rate === 16000 && bits === 16;
    } else if (id === 'data') {
      return fmtOk ? buf.subarray(body, Math.min(body + size, buf.length)) : null;
    }
    pos = body + size + (size % 2); // blocos têm tamanho par
  }
  return null;
}
