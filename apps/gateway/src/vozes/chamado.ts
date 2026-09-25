/*
 * "Miro, grava a reunião": a frase começa chamando o robô pelo nome? E o que vem depois é o
 * comando. Quem decide é o Whisper grande (Groq), que ouviu o "Miro" do dono certo em 7 de 8
 * frases reais — o pequeno, no PC, só filtra o que nem parece o nome (ouvia "primeiro").
 */

const norma = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function dist(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** Palavras a uma letra do nome que são palavras de verdade — "Mira aquele ali" não é chamar o Miro. */
const PARECIDAS_QUE_NAO_SAO = ['mira', 'mimo', 'muro', 'ferro', 'miau', 'giro', 'tiro', 'fiz', 'vira'];

const CHAMAMENTOS = ['ei', 'o', 'oi', 'e', 'hey', 'ai', 'eai', 'fala'];

/** Se a frase chama o robô pelo nome, devolve o comando (o resto da frase); senão, null. */
export function comandoPeloNome(texto: string, nome: string): string | null {
  const palavras = texto.trim().split(/\s+/);
  const n = norma(nome);
  if (!n) return null;
  let i = 0;
  if (CHAMAMENTOS.includes(norma(palavras[0] ?? '')) && palavras.length > 1) i = 1;
  const w = norma(palavras[i] ?? '');
  const bate = w === n || w === `${n}s` || (w.length >= n.length - 1 && dist(w, n) <= 1 && !PARECIDAS_QUE_NAO_SAO.includes(w));
  if (!bate) return null;
  return palavras
    .slice(i + 1)
    .join(' ')
    .replace(/^[\s,.;:!?-]+/, '')
    .trim();
}
