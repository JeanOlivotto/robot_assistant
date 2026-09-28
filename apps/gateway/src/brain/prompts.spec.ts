import { describe, expect, it } from 'vitest';
import { splitEmotion } from './prompts.js';

describe('splitEmotion', () => {
  it('bravo e irritado viram a cara brava; confuso, a de pensando', () => {
    expect(splitEmotion('[bravo] Que grosseria.').face).toBe('angry');
    expect(splitEmotion('[irritado] De novo isso?').face).toBe('angry');
    expect(splitEmotion('[confuso] Não entendi nada.').face).toBe('thinking');
  });
});
