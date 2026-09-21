import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { VoiceSessionService } from './voice-session.service.js';

const make = (owner = 'Jean Olivotto') => new VoiceSessionService({ OWNER_NAME: owner } as unknown as AppConfig);

describe('VoiceSessionService', () => {
  it('cada chamada é uma conversa nova, com corte de histórico próprio', () => {
    const svc = make();
    const a = svc.start();
    const b = svc.start();
    expect(a.id).not.toBe(b.id);
    expect(svc.since(a.id)).toBe(a.startedAt);
    expect(svc.since(b.id)).toBe(b.startedAt);
  });

  it('chamada desconhecida não corta nada (o histórico normal vale)', () => {
    const svc = make();
    expect(svc.since('nao-existe')).toBeUndefined();
    expect(svc.since(undefined)).toBeUndefined();
  });

  it('a abertura chama o dono pelo primeiro nome', () => {
    const greetings = new Set<string>();
    const svc = make();
    for (let i = 0; i < 40; i++) greetings.add(svc.start().greeting);
    expect(greetings.size).toBeGreaterThan(1); // não é sempre a mesma frase
    for (const g of greetings) {
      expect(g.length).toBeLessThan(25); // curta: o robô atende na hora
      expect(g).not.toMatch(/Olivotto/);
    }
    expect([...greetings].some((g) => g.includes('Jean'))).toBe(true);
  });

  it('sem OWNER_NAME a saudação continua fazendo sentido', () => {
    const svc = make('');
    for (let i = 0; i < 20; i++) expect(svc.start().greeting).not.toMatch(/,\s*[!?]|,$/);
  });
});
