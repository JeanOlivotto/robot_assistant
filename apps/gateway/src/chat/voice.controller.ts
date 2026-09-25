import { BadRequestException, Body, Controller, Headers, HttpCode, HttpException, Inject, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import type { ChatVoz } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { SttError, SttService } from '../stt/stt.service.js';
import { BancoVozesService } from '../vozes/banco.service.js';
import { IdentidadeService } from '../identidade/identidade.service.js';
import { comandoPeloNome } from '../vozes/chamado.js';
import { VozesService } from '../vozes/vozes.service.js';
import { TtsService } from '../tts/tts.service.js';
import { ChatService } from './chat.service.js';
import { VoiceSessionService } from './voice-session.service.js';
import { ChamadosService } from './chamados.service.js';
import { deOnde } from './de-onde.js';

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

/**
 * O dono está pedindo para GRAVAR/iniciar uma reunião (não agendar uma).
 * "marcar/agendar reunião" é agenda (vai pro cérebro); "iniciar/gravar/modo reunião" é gravar a ata.
 */
function wantsMeeting(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(marc|agend)\w*/.test(t)) return false;
  if (/modo (de )?reuni/.test(t)) return true;
  if (/\bata\b/.test(t) && /(faz|fazer|grav|com[eç])/.test(t)) return true;
  return /(inici|come[cç]|grav|escut|ouv)\w*/.test(t) && /reuni/.test(t);
}

/** Tira emoji e espaços sobrando — a Siri lê emoji em voz alta ("rosto sorridente..."). */
function forSpeech(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** O que o Whisper "ouve" no silêncio ou no ruído (vem de legenda de vídeo): não é o dono falando. */
const ALUCINACAO = /^(legendas? (pela|por)|amara\.org|inscreva-se|obrigad[oa] por assistir|tchau,? tchau\.?$)/i;

/** Chamados em computadores diferentes dentro deste intervalo são a mesma frase ouvida duas vezes. */
const MESMO_CHAMADO_MS = 4000;

@Controller('api')
@UseGuards(AppTokenGuard)
export class VoiceController {
  private readonly log = new Logger(VoiceController.name);
  /** O último "Miro, …" atendido (e de qual aparelho), para não atender a mesma frase duas vezes. */
  private ultimoChamado: { em: number; origem?: string } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly stt: SttService,
    private readonly chat: ChatService,
    private readonly sessions: VoiceSessionService,
    private readonly tts: TtsService,
    private readonly vozes: VozesService,
    private readonly banco: BancoVozesService,
    private readonly identidade: IdentidadeService,
    private readonly chamados: ChamadosService,
  ) {}

  /**
   * O app do computador ouviu uma frase curta que PODE ser "Miro, …" (o Whisper pequeno de lá
   * só filtra). Aqui o grande confirma: se chamou, devolve o comando; se não, a frase é
   * descartada — não vira conversa nem fica guardada.
   * `seguimento=1`: é a continuação logo depois de um "Miro?" (ou de uma pergunta dele) — aí não
   * precisa do nome, a frase inteira é o comando.
   * Junto, descobre de quem é a voz: o `ref` devolvido vai no say, e o comando entra como fala
   * daquela pessoa (quem não é o dono não mexe no computador).
   */
  @Post('voice/chamado')
  @HttpCode(200)
  async chamado(
    @Body() audio: unknown,
    @Headers() h: Record<string, string | undefined> = {},
    @Query('seguimento') seguimento?: string,
  ): Promise<{ chamou: boolean; nome: string; texto?: string; comando?: string; ref?: string }> {
    if (!Buffer.isBuffer(audio) || !audio.length) throw new BadRequestException('mande o áudio no corpo (Content-Type audio/*)');
    const nome = this.identidade.nome;
    try {
      const voz = this.quemFalaAte(audio, 2500);
      const { text } = await this.stt.transcribe(audio, { dica: false });
      const peloNome = comandoPeloNome(text, nome);
      const falado = text.replace(/[[(][^\])]*[\])]/g, ' ').trim(); // "[música]" não é fala
      const comando = peloNome ?? (seguimento === '1' && falado && !ALUCINACAO.test(falado) ? falado : null);
      if (comando === null) return { chamou: false, nome };
      // Continuação sem o nome: só a voz do dono. Em volta tem gente conversando, e a conversa aberta
      // não pode virar comando de qualquer um. Sem resposta do banco de vozes, confia.
      if (peloNome === null) {
        const quem = await voz;
        const dono = (this.cfg.OWNER_NAME || '').trim().toLowerCase();
        if (quem && !(quem.certeza === 'alta' && quem.nome?.trim().toLowerCase() === dono)) {
          this.log.log(`Continuação "${text}" ignorada: voz de ${quem.nome ?? 'alguém que não conheço'}`);
          return { chamou: false, nome };
        }
      }
      // Dois computadores perto um do outro ouvem a mesma frase: atende quem chegou primeiro, o
      // outro fica quieto (antes os dois mandavam o comando e ele respondia duas vezes).
      const { origem } = deOnde(h);
      const agora = Date.now();
      const ultimo = this.ultimoChamado;
      if (ultimo && agora - ultimo.em < MESMO_CHAMADO_MS && (!origem || origem !== ultimo.origem)) {
        this.log.log(`Chamado "${text}" ignorado: outro computador já atendeu`);
        return { chamou: false, nome };
      }
      this.ultimoChamado = { em: agora, origem };
      const quem = await voz;
      this.log.log(`${peloNome === null ? 'Continuação' : 'Chamado pelo nome'} no computador: "${text}" (voz: ${quem?.nome ?? quem?.certeza ?? '?'})`);
      return { chamou: true, nome, texto: text, comando, ref: this.chamados.guardar(quem) };
    } catch (err) {
      if (err instanceof SttError && err.status === 422) return { chamou: false, nome };
      throw err instanceof SttError ? new HttpException(err.message, err.status) : err;
    }
  }

  /**
   * De quem é esta voz, pelo banco. Roda em paralelo com a transcrição, então não atrasa a
   * resposta. Voz que ele não tem certeza fica guardada: se a pessoa disser o nome, salvar_voz usa.
   */
  /**
   * quemFala com prazo: a resposta não pode esperar o reconhecimento de voz (o serviço de vozes é
   * um só e pode estar ocupado separando as vozes de uma reunião). Passou do prazo, segue sem.
   */
  private quemFalaAte(audio: Buffer, ms: number): Promise<ChatVoz | undefined> {
    return Promise.race([this.quemFala(audio), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  }

  private async quemFala(audio: Buffer): Promise<ChatVoz | undefined> {
    if (!this.vozes.enabled) return undefined;
    try {
      const emb = await this.vozes.assinatura(await this.stt.toPcm(audio));
      if (!emb) return undefined; // curto demais: melhor não dizer nada que chutar
      const r = this.banco.identificar(emb);
      if (r?.certeza === 'alta') {
        this.banco.reforcar(r, emb);
        return { certeza: 'alta', nome: r.nome, score: r.score };
      }
      // No app do próprio dono, "parecida com a do dono" é ele: perguntar "é você?" a cada fala curta
      // (a assinatura de fala curta varia muito) cansava. Para os outros, segue confirmando.
      const dono = (this.cfg.OWNER_NAME || '').trim().toLowerCase();
      if (r?.certeza === 'duvida' && dono && r.nome.trim().toLowerCase() === dono) return { certeza: 'alta', nome: r.nome, score: r.score };
      this.banco.guardarPendente(emb);
      return r ? { certeza: 'duvida', nome: r.nome, score: r.score } : { certeza: 'desconhecida' };
    } catch {
      return undefined;
    }
  }

  /**
   * O app abriu o modo chamada: começa uma conversa nova e devolve a fala de abertura.
   * O mp3 da saudação já vai sendo gerado aqui, para o robô atender sem aquele silêncio inicial.
   */
  @Post('voice/session')
  @HttpCode(200)
  session(): { session: string; greeting: string } {
    const s = this.sessions.start();
    this.chat.acordar('happy', 2500); // atendeu a ligação: o da mesa acorda junto
    void this.tts.synth(s.greeting).catch(() => undefined);
    return { session: s.id, greeting: s.greeting };
  }

  /** Mensagem de voz do webapp: áudio no corpo (AAC do iPhone, Opus, WAV). A resposta chega pelo WebSocket. */
  @Post('voice')
  async voice(@Body() audio: unknown, @Headers() h: Record<string, string | undefined>): Promise<{ text: string; seconds: number }> {
    if (!Buffer.isBuffer(audio) || !audio.length) throw new BadRequestException('mande o áudio no corpo (Content-Type audio/*)');
    try {
      const [{ text, seconds }, voz] = await Promise.all([this.stt.transcribe(audio), this.quemFalaAte(audio, 3000)]);
      if (!text) throw new SttError('não entendi nada nesse áudio', 422);
      void this.chat.say(text, 'voice', { voz, ...deOnde(h) });
      return { text, seconds };
    } catch (err) {
      if (err instanceof SttError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  /** Conversa por voz: áudio entra, transcrição e resposta pronta pra falar saem (para o loop de conversa). */
  @Post('voice/converse')
  async converse(
    @Body() audio: unknown,
    @Query('s') session?: string,
    @Headers() h: Record<string, string | undefined> = {},
  ): Promise<{ you: string; reply: string; face: string; action?: 'start_meeting' }> {
    if (!Buffer.isBuffer(audio) || !audio.length) throw new BadRequestException('mande o áudio no corpo (Content-Type audio/*)');
    try {
      const t0 = Date.now();
      let tStt = 0;
      const [{ text }, voz] = await Promise.all([
        this.stt.transcribe(audio).finally(() => (tStt = Date.now() - t0)),
        this.quemFalaAte(audio, 1500),
      ]);
      const tOuvir = Date.now() - t0;
      if (!text) throw new SttError('não entendi nada nesse áudio', 422);
      // Pediu para gravar uma reunião: o app entra no modo reunião (não vira conversa nem agenda).
      if (wantsMeeting(text)) {
        return { you: text, reply: 'Bora! Tô abrindo o modo reunião e já começo a gravar. Pode falar!', face: 'happy', action: 'start_meeting' };
      }
      const reply = await this.chat.ask(text, 'voice', { since: this.sessions.since(session), spoken: true, voz, ...deOnde(h) });
      // Onde vai o tempo de cada fala da ligação (transcrição, voz, cérebro) — é por aqui que se afina.
      this.log.log(`Ligação: transcrição ${tStt} ms, ouvir+voz ${tOuvir} ms, cérebro ${Date.now() - t0 - tOuvir} ms`);
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
