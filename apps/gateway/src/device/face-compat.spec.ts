import { describe, expect, it } from 'vitest';
import { caraPara } from './face-compat.js';

describe('caraPara', () => {
  it('firmware novo recebe as caras novas', () => {
    expect(caraPara('confused', '0.17.0')).toBe('confused');
    expect(caraPara('annoyed', '1.0.0')).toBe('annoyed');
  });

  it('firmware velho (ou desconhecido) recebe a mais parecida', () => {
    expect(caraPara('confused', '0.16.2')).toBe('thinking');
    expect(caraPara('annoyed', '0.9.10')).toBe('angry');
    expect(caraPara('annoyed', undefined)).toBe('angry');
  });

  it('cara antiga passa direto', () => {
    expect(caraPara('happy', '0.1.0')).toBe('happy');
  });
});
