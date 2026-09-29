/**
 * "Sim" ou "não" para a proposta em aberto, do jeito que se fala ou digita — "sim, pode mandar",
 * "manda aí", "Miro, pode gravar", "não, deixa". Frase com mais coisa ("não, manda em áudio",
 * "sim mas muda o horário") não é resposta: é pedido novo, e vai para o cérebro.
 */
const SIM = new Set(
  (
    'sim s ss pode podes manda mandar mande envia enviar envie confirma confirmo confirmado confirmar ok okay oks ' +
    'isso bora claro beleza blz fechou fecha vai grava gravar grave roda rodar rode marca marcar marque certo ' +
    'perfeito show top exato positivo yes ver crer ser ai la agora ja favor por pfv pf entao aquilo vamos'
  ).split(' '),
);
/** O que faz a frase ser um "sim" (as outras palavras só acompanham: "pode mandar aí", "por favor"). */
const SIM_NUCLEO = new Set(
  'sim s ss pode podes manda mandar mande envia enviar envie confirma confirmo confirmado confirmar ok okay oks isso bora claro beleza blz fechou fecha vai grava gravar grave roda rodar rode marca marcar marque certo perfeito show top exato positivo yes'.split(' '),
);
const NAO = new Set('nao n cancela cancelar cancele deixa esquece pra la nem precisa melhor obrigado valeu agora mais tarde ai nada nao'.split(' '));
const NAO_NUCLEO = new Set('nao n cancela cancelar cancele deixa esquece nem'.split(' '));

const palavras = (t: string, nomes: string[]) => {
  const limpo = t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const semNome = new Set(nomes.map((n) => n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')));
  return limpo.split(' ').filter((w) => w && !semNome.has(w));
};

/** true = sim, false = não, null = não é resposta (é outra coisa). */
export function simOuNao(texto: string, nomes: string[] = []): boolean | null {
  const w = palavras(texto, nomes);
  if (!w.length || w.length > 6) return null;
  if (w.some((x) => NAO_NUCLEO.has(x)) && w.every((x) => NAO.has(x))) return false;
  if (w.some((x) => SIM_NUCLEO.has(x)) && w.every((x) => SIM.has(x))) return true;
  return null;
}
