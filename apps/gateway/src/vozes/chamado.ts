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
const PARECIDAS_QUE_NAO_SAO = ['mira', 'mimo', 'muro', 'ferro', 'miau', 'giro', 'tiro', 'fiz', 'vira', 'mero'];

/** O que vem antes do nome quando se chama alguém: "Ei Miro", "Ok Miro", "Beleza, Miro". */
const CHAMAMENTOS = ['ei', 'o', 'oi', 'e', 'hey', 'ai', 'eai', 'fala', 'ok', 'okay', 'ola', 'alo', 'opa', 'beleza', 'bom', 'dia', 'boa', 'tarde', 'noite', 'escuta', 'olha', 'entao'];

function eONome(palavra: string, n: string): boolean {
  const w = norma(palavra);
  if (w === n || w === `${n}s`) return true;
  if (w.length < n.length - 1 || dist(w, n) > 1) return false;
  // "Mira" pode ser o Whisper ouvindo "Miro" (ouviu assim o "Miro, esconde" do dono) ou o verbo
  // ("Mira aquele ali"). Quem chama faz pausa: só vale com vírgula/pergunta colada.
  return !PARECIDAS_QUE_NAO_SAO.includes(w) || /[,?!]$/.test(palavra.trim());
}

const limpa = (t: string) => t.replace(/^[\s,.;:!?-]+|[\s,;:-]+$/g, '').trim();

/**
 * Se a frase chama o robô pelo nome, devolve o comando; senão, null. Vale o nome:
 *  - no começo de uma frase (ou depois de "ei", "ok", "beleza"…): "Ok Miro, abre o navegador";
 *  - no começo de uma frase que vem depois de outra: "Tá alto isso. Miro, abaixa o volume";
 *  - no fim, depois de vírgula: "Que horas são, Miro?".
 * O nome no meio de uma frase ("falei com o Miro sobre isso") não conta.
 */
export function comandoPeloNome(texto: string, nome: string): string | null {
  const n = norma(nome);
  if (!n) return null;
  // "[música]", "(risos)": anotação do Whisper, não fala.
  const t = texto.replace(/[[(][^\])]*[\])]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // Cada frase (separada por . ! ?), olhando o começo dela.
  const frases = t.split(/(?<=[.!?])\s+/);
  for (let f = 0; f < frases.length; f++) {
    const palavras = frases[f]!.split(/\s+/);
    for (let i = 0; i < Math.min(3, palavras.length); i++) {
      if (eONome(palavras[i]!, n)) {
        // Antes do nome só pode ter chamamento ("ei", "ok", "beleza,")
        if (!palavras.slice(0, i).every((w) => CHAMAMENTOS.includes(norma(w)))) break;
        const resto = [palavras.slice(i + 1).join(' '), ...frases.slice(f + 1)].join(' ');
        return limpa(resto);
      }
      if (!CHAMAMENTOS.includes(norma(palavras[i]!))) break;
    }
  }

  // "…, Miro?" no fim: o comando é o que veio antes.
  const fim = t.match(/^(.*\S)\s*,\s*(\S+?)[\s.!?]*$/);
  if (fim && eONome(fim[2]!, n)) return limpa(fim[1]!);
  return null;
}
