import { describe, expect, it } from 'vitest';
import { pendenciasConcluidas } from './brain.service.js';

const abertas = ['honorários do Matheus', 'acesso do Kleiton', 'e-mail da Anne'];

describe('pendenciasConcluidas: o que o concluir_pendencia leva', () => {
  it('"todas" leva a lista inteira, não só a primeira', () => {
    expect(pendenciasConcluidas({ todas: true }, abertas)).toEqual(abertas);
  });

  it('aceita vários números e o "numero" antigo', () => {
    expect(pendenciasConcluidas({ numeros: [3, 1] }, abertas)).toEqual(['e-mail da Anne', 'honorários do Matheus']);
    expect(pendenciasConcluidas({ numero: 2 }, abertas)).toEqual(['acesso do Kleiton']);
  });

  it('recusa número que não existe e pedido vazio', () => {
    expect(pendenciasConcluidas({ numeros: [1, 7] }, abertas)).toBeNull();
    expect(pendenciasConcluidas({}, abertas)).toBeNull();
    expect(pendenciasConcluidas({ todas: true }, [])).toBeNull();
  });
});
