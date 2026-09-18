import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'use HH:MM');
const bool = z
  .string()
  .default('true')
  .transform((s) => !['0', 'false', 'no', 'nao', 'não'].includes(s.toLowerCase()));

const Schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  DEVICE_TOKEN: z.string().min(8, 'DEVICE_TOKEN precisa de pelo menos 8 caracteres'),
  APP_TOKEN: z.string().min(8, 'APP_TOKEN (senha do webapp) precisa de pelo menos 8 caracteres'),

  /* Agenda: conta de serviço (lê e escreve) tem prioridade; senão, link iCal (só lê). */
  GOOGLE_SA_KEY_FILE: z.string().default(''),
  GCAL_ID: z.string().default(''),
  GCAL_ICS_URL: z
    .string()
    .default('')
    .refine((s) => s === '' || s.startsWith('https://'), 'GCAL_ICS_URL deve começar com https://'),

  TZ_NAME: z.string().default('America/Sao_Paulo'),
  TZ_POSIX: z.string().default('<-03>3'),
  ALERT_LEAD_MIN: z.coerce.number().int().min(1).max(120).default(10),
  CALENDAR_POLL_SEC: z.coerce.number().int().min(30).default(120),
  AGENDA_HORIZON_H: z.coerce.number().int().min(1).max(168).default(36),

  /* Cérebro principal: qualquer API compatível com OpenAI (padrão: Groq, rápido e com plano grátis). */
  LLM_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('openai/gpt-oss-120b'),
  /* Reserva quando o principal falha. Sem LLM_FALLBACK_API_KEY, usa o mesmo provedor do principal. */
  LLM_FALLBACK_BASE_URL: z.string().default('https://integrate.api.nvidia.com/v1'),
  LLM_FALLBACK_API_KEY: z.string().default(''),
  LLM_FALLBACK_MODELS: z.string().default('google/gemma-4-31b-it,z-ai/glm-5.3'),

  /* Transcrição: Whisper large-v3 hospedado na NVIDIA (gRPC do Riva).
     Chave vazia = usa LLM_FALLBACK_API_KEY (NVIDIA) ou, por último, LLM_API_KEY. */
  /* groq: Whisper turbo, rápido, um tiro só (reusa LLM_API_KEY). nvidia: Riva gRPC (antigo). */
  STT_PROVIDER: z.enum(['groq', 'nvidia']).default('groq'),
  STT_MODEL: z.string().default('whisper-large-v3-turbo'),
  STT_ENDPOINT: z.string().default('grpc.nvcf.nvidia.com:443'),
  STT_FUNCTION_ID: z.string().default('b702f636-f60c-4a3d-a6f4-f3568c13bd7d'),
  STT_API_KEY: z.string().default(''),
  STT_LANGUAGE: z.string().default('pt'),
  FFMPEG_PATH: z.string().default('ffmpeg'),

  /* Notificação push no celular (Web Push). Gerar com: npx web-push generate-vapid-keys */
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:robo@localhost'),

  /* Voz das respostas. edge = vozes neurais do "Ler em voz alta" do Edge (grátis, sem chave,
     não oficial); elevenlabs = precisa de chave; off = o app usa a voz do aparelho. */
  TTS_PROVIDER: z.enum(['edge', 'elevenlabs', 'off']).default('edge'),
  EDGE_TTS_BIN: z.string().default('edge-tts'),
  EDGE_TTS_VOICE: z.string().default('pt-BR-AntonioNeural'),
  EDGE_TTS_RATE: z.string().default('+0%'),
  ELEVENLABS_API_KEY: z.string().default(''),
  ELEVENLABS_VOICE_ID: z.string().default(''),
  ELEVENLABS_MODEL: z.string().default('eleven_flash_v2_5'),

  ROBOT_NAME: z.string().default('Robô'),
  OWNER_NAME: z.string().default(''),

  PROACTIVE: bool,
  MORNING_AT: hhmm.default('08:00'),
  EVENING_AT: hhmm.default('18:00'),
  /** Dias sem tocar num assunto até o robô puxá-lo de volta ("faz tempo que não falamos disso"). */
  MEMORY_RECALL_DAYS: z.coerce.number().int().min(1).max(60).default(4),

  /* Avisa (celular + telinha) ao cruzar estes % de uso do Claude, por janela. Vazio = não avisa. */
  CLAUDE_ALERT_PERCENTS: z
    .string()
    .default('50,80,95')
    .transform((s) =>
      [...new Set(s.split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0 && n <= 1000))].sort(
        (a, b) => a - b,
      ),
    ),

  /* Spotify: mostra no robô o que está tocando. Client ID/Secret do painel de dev; refresh token vem da autorização. */
  SPOTIFY_CLIENT_ID: z.string().default(''),
  SPOTIFY_CLIENT_SECRET: z.string().default(''),
  SPOTIFY_REDIRECT_URI: z.string().default('https://srv1966497.hstgr.cloud/api/spotify/callback'),
  SPOTIFY_POLL_SEC: z.coerce.number().int().min(3).max(60).default(5),

  DATA_DIR: z.string().default('data'),
});

export type AppConfig = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const r = Schema.safeParse(env);
  if (!r.success) {
    throw new Error(`Configuração inválida no .env:\n${z.prettifyError(r.error)}`);
  }
  return r.data;
}
