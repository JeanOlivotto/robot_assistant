/** Lê as respostas do robô em voz alta com a voz pt-BR do próprio aparelho (sem servidor). */

let voice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang === 'pt-BR') ?? voices.find((v) => v.lang.startsWith('pt')) ?? null;
}

export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

if (speechSupported) {
  window.speechSynthesis.onvoiceschanged = () => {
    voice = pickVoice();
  };
}

export function speak(text: string): void {
  if (!speechSupported) return;
  const clean = text.replace(/\p{Extended_Pictographic}|️|‍/gu, '').trim();
  if (!clean) return;
  voice ??= pickVoice();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'pt-BR';
  if (voice) u.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (speechSupported) window.speechSynthesis.cancel();
}
