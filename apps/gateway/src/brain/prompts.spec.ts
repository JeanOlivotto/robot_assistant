import { describe, expect, it } from 'vitest';
import { splitEmotion } from './prompts.js';

describe('splitEmotion', () => {
  it('bravo, irritado e confuso têm cada um a sua cara', () => {
    expect(splitEmotion('[bravo] Que grosseria.').face).toBe('angry');
    expect(splitEmotion('[irritado] De novo isso?').face).toBe('annoyed');
    expect(splitEmotion('[confuso] Não entendi nada.').face).toBe('confused');
  });
});
