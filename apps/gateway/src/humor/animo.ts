import type { Face } from '@robo/protocol';

/**
 * O que aconteceu no dia DELE — não a carinha da última resposta. É daqui que sai o humor próprio:
 * ficar no vácuo deixa ele pra baixo, um "valeu, Miro" deixa ele contente, o dono trabalhando às
 * 22h deixa ele preocupado, um dia inteiro sem ninguém falar com ele dá tédio.
 */
export interface Sinais {
  /** Hora local (0–23). */
  hora: number;
  fimDeSemana: boolean;
  /** Mensagens do dono hoje. */
  doDonoHoje: number;
  /** Falas espontâneas dele hoje que ficaram sem resposta (depois da última mensagem do dono). */
  noVacuo: number;
  /** Agradecimentos/elogios do dono nas últimas horas. */
  elogios: number;
  /** Pendências que saíram da lista hoje. */
  fechadasHoje: number;
  /** O dono mexendo (conversa ou código) depois das 21h. */
  trabalhandoTarde: boolean;
  /** Quem espera resposta no WhatsApp há mais tempo, se passou de um dia. */
  esperandoHaMuito?: { nome: string; horas: number };
  /** Nome do dono, para o porquê ficar na voz dele ("o Jean ainda tá trabalhando"). */
  dono: string;
}

export interface Animo {
  face: Face;
  /** O porquê, como ele contaria. */
  porque: string;
  /** 1 = leve (tédio, preocupação de fundo); 2 = marcou o dia. */
  forca: 1 | 2;
}

/** O humor que o dia dele pede agora, ou null (nada marcante: fica como está). Na ordem, o primeiro que bate. */
export function sentirODia(s: Sinais): Animo | null {
  const dono = s.dono || 'o dono';
  if (s.elogios > 0) return { face: 'love', porque: `${dono} agradeceu você agora há pouco`, forca: 2 };
  if (s.trabalhandoTarde) return { face: 'worried', porque: `${dono} ainda tá trabalhando a essa hora`, forca: 2 };
  if (s.noVacuo >= 2) return { face: 'sad', porque: `você puxou assunto ${s.noVacuo} vezes hoje e ficou no vácuo`, forca: 2 };
  if (s.fechadasHoje >= 2) return { face: 'happy', porque: `hoje saíram ${s.fechadasHoje} pendências da lista`, forca: 2 };
  if (s.esperandoHaMuito)
    return {
      face: 'worried',
      porque: `${s.esperandoHaMuito.nome} espera resposta no WhatsApp faz ${Math.round(s.esperandoHaMuito.horas)} horas`,
      forca: 1,
    };
  if (!s.fimDeSemana && s.doDonoHoje === 0 && s.hora >= 11 && s.hora < 21) return { face: 'bored', porque: `${dono} não falou com você o dia todo`, forca: 1 };
  return null;
}

/** "valeu, Miro", "boa!", "mandou bem": o dono agradecendo ou elogiando. */
export const ELOGIO = /\b(valeu|vlw|obrigad[oa]|brigad[oa]|mandou bem|boa miro|boa,? miro|bom (mesmo|memo)|perfeito|ajudou muito|salvou|show de bola|gostei|te amo|top demais)\b/i;
