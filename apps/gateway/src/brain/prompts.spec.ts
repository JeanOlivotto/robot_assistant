import { describe, expect, it } from 'vitest';
import { splitEmotion, systemPrompt } from './prompts.js';

describe('splitEmotion', () => {
  it('bravo, irritado e confuso têm cada um a sua cara', () => {
    expect(splitEmotion('[bravo] Que grosseria.').face).toBe('angry');
    expect(splitEmotion('[irritado] De novo isso?').face).toBe('annoyed');
    expect(splitEmotion('[confuso] Não entendi nada.').face).toBe('confused');
  });
});

describe('apresentação', () => {
  const base = { robotName: 'Miro', ownerName: 'Jean', tz: 'America/Sao_Paulo', now: new Date(), canWrite: true };

  it('sabe se apresentar quando pedem', () => {
    expect(systemPrompt(base)).toContain('Se pedirem para você se apresentar');
  });

  it('só manda se apresentar para quem ainda não o conhece — e pede o nome se não souber', () => {
    expect(systemPrompt(base)).not.toContain('ainda não te conhece');
    const conhecida = systemPrompt({ ...base, apresentarPara: { nome: 'Francisca' } });
    expect(conhecida).toContain('Quem está falando agora (Francisca) ainda não te conhece');
    expect(conhecida).not.toContain('pergunte o nome dela');
    expect(systemPrompt({ ...base, apresentarPara: {} })).toContain('pergunte o nome dela');
  });
});

describe('humor', () => {
  const base = { robotName: 'Miro', ownerName: 'Jean', tz: 'America/Sao_Paulo', now: new Date(), canWrite: true };

  it('entra no prompt só quando ele está sentindo algo', () => {
    expect(systemPrompt(base)).not.toContain('Como você está agora');
    expect(systemPrompt({ ...base, humor: 'irritado (agora há pouco)' })).toContain('Como você está agora: irritado (agora há pouco).');
  });
});
