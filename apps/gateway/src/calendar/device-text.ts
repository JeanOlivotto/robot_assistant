import { utf8Bytes } from '@robo/protocol';

/* Troca pontuação tipográfica comum por ASCII, que a fonte do robô desenha. */
const REPLACEMENTS: Record<string, string> = {
  '–': '-', // –
  '—': '-', // —
  '•': '-', // •
  '…': '...', // …
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
};

/**
 * Prepara texto para a tela do robô: só Latin-1 (a fonte cobre ASCII + acentos do português),
 * espaços normalizados e corte em `maxBytes` bytes UTF-8 sem quebrar caractere.
 */
export function deviceText(input: string, maxBytes: number, fallback = ''): string {
  const spaced = [...input.normalize('NFC')]
    .map((ch) => REPLACEMENTS[ch] ?? ch)
    .join('')
    .replace(/\s+/g, ' ');
  const cleaned = [...spaced]
    .filter((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0x20 && cp <= 0xff && cp !== 0x7f;
    })
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();

  let out = '';
  let used = 0;
  for (const ch of cleaned) {
    const b = utf8Bytes(ch);
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out.trimEnd() || fallback;
}
