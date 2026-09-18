import { BadRequestException, Body, Controller, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { SttError, SttService } from '../stt/stt.service.js';
import { ChatService } from './chat.service.js';

/**
 * Texto do atalho da Siri. Tolerante de propósito: {"text": ...} é o certo, mas aceita a primeira
 * string do JSON (chave errada ou vazia no Atalhos) ou o corpo em texto puro.
 */
function askText(body: unknown): string {
  if (typeof body === 'string') return body.trim();
  if (body && typeof body === 'object') {
    const fields = body as Record<string, unknown>;
    if (typeof fields.text === 'string') return fields.text.trim();
    const first = Object.values(fields).find((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (first) return first.trim();
  }
  return '';
}

/** Tira emoji e espaços sobrando — a Siri lê emoji em voz alta ("rosto sorridente..."). */
function forSpeech(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

@Controller('api')
@UseGuards(AppTokenGuard)
export class VoiceController {
  constructor(
    private readonly stt: SttService,
    private readonly chat: ChatService,
  ) {}

  /** Mensagem de voz do webapp: áudio no corpo (AAC do iPhone, Opus, WAV). A resposta chega pelo WebSocket. */
  @Post('voice')
  async voice(@Body() audio: unknown): Promise<{ text: string; seconds: number }> {
    if (!Buffer.isBuffer(audio) || !audio.length) throw new BadRequestException('mande o áudio no corpo (Content-Type audio/*)');
    try {
      const { text, seconds } = await this.stt.transcribe(audio);
      if (!text) throw new SttError('não entendi nada nesse áudio', 422);
      void this.chat.say(text, 'voice');
      return { text, seconds };
    } catch (err) {
      if (err instanceof SttError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  /** Conversa por voz: áudio entra, transcrição e resposta pronta pra falar saem (para o loop de conversa). */
  @Post('voice/converse')
  async converse(@Body() audio: unknown): Promise<{ you: string; reply: string; face: string }> {
    if (!Buffer.isBuffer(audio) || !audio.length) throw new BadRequestException('mande o áudio no corpo (Content-Type audio/*)');
    try {
      const { text } = await this.stt.transcribe(audio);
      if (!text) throw new SttError('não entendi nada nesse áudio', 422);
      const reply = await this.chat.ask(text, 'voice');
      return {
        you: text,
        reply: reply ? forSpeech(reply.text) : 'Hmm, não sei o que dizer agora.',
        face: reply?.face ?? 'neutral',
      };
    } catch (err) {
      if (err instanceof SttError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  /** Atalho da Siri: texto ditado entra, resposta pronta para ser falada sai. */
  @Post('ask')
  @HttpCode(200)
  async ask(@Body() body: unknown): Promise<{ reply: string; face: string }> {
    // Sempre responde algo falável: um 400 deixaria a Siri em silêncio.
    const text = askText(body).slice(0, 2000);
    if (!text) return { reply: 'Não ouvi nada... pode repetir?', face: 'thinking' };
    const reply = await this.chat.ask(text, 'siri');
    return {
      reply: reply ? forSpeech(reply.text) : 'Hmm, não tenho nada pra dizer agora.',
      face: reply?.face ?? 'neutral',
    };
  }
}
