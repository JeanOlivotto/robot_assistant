# Miro — robô assistente de mesa

O Miro é um robozinho de mesa com personalidade: ouve, responde com voz, mostra uma carinha
animada num LCD de 1,44" e cuida da rotina do dono — agenda, pendências, reuniões, WhatsApp e
até o computador. O aparelho **não pensa**: é microfone, alto-falante, tela e Wi-Fi. Toda a
inteligência mora num servidor (NestJS) que fala com o robô, com o app no celular e com o app
no computador.

```
   ESP32-C3 (carinha, botões)          celular / navegador            computador (Electron)
   └─ wss /device ──────────┐          └─ wss /app ──────┐          ┌── bolha + ouvido + braço
                            ▼                            ▼          ▼
                  ┌──────────────────────── gateway (NestJS) ────────────────────────┐
                  │ cérebro (LLM + ferramentas) · memória em grafo · humor · diário  │
                  │ agenda Google · pendências · reuniões · WhatsApp · push · TTS    │
                  └──────┬──────────────┬───────────────┬──────────────┬─────────────┘
                         ▼              ▼               ▼              ▼
                  Claude (Sonnet/   Groq / NVIDIA    Whisper (STT)   vozes (diarização,
                  Haiku)            (reserva)        Edge/Eleven TTS  container próprio)
```

## O que ele faz

**Conversa e personalidade**
- Cérebro no **Claude Sonnet**, com o Haiku para tarefas leves e **Groq → NVIDIA** de reserva
  automática (cota estourada, recusa ou queda passam para o próximo sem o dono perceber).
- **Memória de longo prazo em grafo** (pessoas, projetos, metas e como se ligam); no prompt entra
  só a vizinhança do assunto da conversa.
- **Humor** que dura algumas horas, **diário** do dia anterior ("ontem você tava brigando com o
  deploy") e mensagens proativas de manhã e à noite.
- Enxerga **fotos** mandadas pelo app (descrição guardada para lembrar depois).
- Voz: Edge TTS (grátis) ou ElevenLabs; fala transcrita com Whisper.

**Rotina**
- **Agenda Google**: consulta, avisa na tela antes de cada compromisso e cria eventos.
- **Pendências**: anota, edita e conclui por voz ou chat.
- **Modo reunião**: grava a sala (ou uma ligação do WhatsApp), transcreve, separa **quem falou
  quando** pelo banco de vozes e entrega ata com itens de ação. Dá para mandar um link de
  convite para outra pessoa gravar no seu lugar.
- **Presença**: sabe se você está na mesa pelo Bluetooth do iPhone.
- Mostra a música do **Spotify** na tela; avisa o uso da cota do Claude.

**WhatsApp** (via [Baileys](https://github.com/WhiskeySockets/Baileys))
- Lê e resume conversas, prepara mensagens (texto, áudio com a voz dele, figurinha da carinha)
  que só saem depois do seu "sim".
- Atende em grupos liberados quando é chamado — e entende quando alguém responde ao que ele
  disse sem citar o nome; sabe quando a conversa acabou.
- Pode **cobrir você** (férias, reunião) respondendo no seu lugar.

**Computador**
- App desktop com a **bolha** (carinha flutuante sempre por cima) e o painel completo.
- **"Miro, …" por voz** no PC: Whisper tiny local filtra, o servidor confirma.
- **Braço**: roda comandos na sua máquina — os escritos na hora só depois da aprovação; ações
  cadastradas em `acoes.json` sem perguntar. Também liga o PC por Wake-on-LAN.
- **Olho no código**: espia o arquivo aberto no VS Code e o `git diff` e comenta (ou fica quieto).
- **Programador** e **consultor**: delega ao Claude Code criar um projeto em `~/Projects/miro/` ou
  explicar o código dos seus projetos (só leitura, sem acesso a segredos).

> Regra de ouro: tudo que **escreve fora** (evento, comando, mensagem) vira um cartão de proposta
> e espera o "sim" do dono.

## Estrutura

| Pasta | O que é |
|---|---|
| [`apps/gateway`](apps/gateway) | Servidor NestJS: cérebro, integrações, WebSockets `/device`, `/app` e `/braco`, API HTTP |
| [`apps/web`](apps/web) | App React (Vite) — chat, agenda, pendências, reunião, memória, WhatsApp, PC; PWA com push |
| [`apps/desktop`](apps/desktop) | App Electron: bolha, ouvido de voz, braço, olho no código, programador |
| [`apps/braco`](apps/braco) | Braço avulso (Node puro) para máquinas sem o app desktop |
| [`apps/vozes`](apps/vozes) | Diarização em CPU com sherpa-onnx — container separado |
| [`packages/protocol`](packages/protocol) | Contratos zod compartilhados (robô ↔ servidor ↔ app) e geração do header C |
| [`firmware`](firmware) | ESP-IDF 5.5 em C para o ESP32-C3: carinha, UI, Wi-Fi, OTA, presença |
| [`tools`](tools) | Publicação de firmware, preview da tela no PC, protótipo da palavra de ativação |
| [`deploy`](deploy) | Script de deploy, nginx e lista de exclusões do rsync |

## Rodando localmente

Requisitos: Node ≥ 22 e pnpm 12 (`corepack enable`, ou `npx -y pnpm@12.4.2` no lugar de `pnpm`).

```bash
pnpm install
cp .env.example .env        # preencha pelo menos DEVICE_TOKEN, APP_TOKEN e uma chave de LLM
pnpm dev                    # gateway em http://localhost:8080 (builda o protocol antes)
pnpm dev:web                # app web com hot reload
```

Sem o robô na mesa dá para simular os dois lados:

```bash
pnpm fake-device            # finge ser o ESP32 conectado em /device
pnpm fake-app               # finge ser o app em /app
```

Outros comandos:

```bash
pnpm test                   # testes do gateway (vitest)
pnpm build                  # builda todos os pacotes
pnpm desktop                # abre o app desktop
pnpm gen:c                  # regenera o header C do protocolo para o firmware
```

### Configuração

Tudo vem do `.env` — o [`.env.example`](.env.example) documenta cada variável. Os blocos principais:

| Bloco | Variáveis | Sem ela… |
|---|---|---|
| Acesso | `DEVICE_TOKEN`, `APP_TOKEN`, `BRACO_TOKEN` | não sobe |
| Claude | `API_CLAUDE`, `CLAUDE_MODEL`, `CLAUDE_MODEL_LEVE`, `CLAUDE_EFFORT` | o cérebro fica no Groq/NVIDIA |
| Reserva | `LLM_*`, `LLM_FALLBACK_*`, `VISION_*` | sem rede de segurança se o Claude cair |
| Agenda | `GOOGLE_SA_KEY_FILE`, `GCAL_ID`, `GCAL_ICS_URL` | agenda vazia (ou só leitura, sem a conta de serviço) |
| Voz | `STT_API_KEY`, `TTS_PROVIDER`, `EDGE_TTS_*`, `ELEVENLABS_*` | sem transcrição / voz padrão |
| Push | `VAPID_*` | sem notificação no celular |
| Spotify | `SPOTIFY_*` | sem música na tela |

## Firmware

Placa: SpotPear ESP32-C3 "Mini TV" 1,44" (ST7735S 128×128, 16 MB de flash) — detalhes e
pinagem em [`firmware/BOARD.md`](firmware/BOARD.md).

```bash
cp firmware/main/secrets.example.h firmware/main/secrets.h   # Wi-Fi e token do robô

# build (Docker; o mount de firmware/ como /project é obrigatório)
docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp -v "$PWD/firmware":/project -w /project \
  espressif/idf:v5.5.5 idf.py build

# primeira gravação, pelo cabo
docker run --rm --device /dev/ttyACM0 -v "$PWD/firmware":/project -w /project \
  espressif/idf:v5.5.5 idf.py -p /dev/ttyACM0 flash

# depois disso, atualização pelo Wi-Fi (OTA)
pnpm publish:fw
```

O deploy do servidor **não** atualiza o robô: firmware novo só chega com o `publish:fw`. A versão
sai do `PROJECT_VER` em `firmware/CMakeLists.txt`.

## Deploy

Push na `main` que mexe no servidor (fora `firmware/` e `*.md`) roda testes e build no GitHub
Actions, sincroniza o código na VPS por rsync e reconstrói os containers `robo-gateway` e
`robo-vozes`. Os segredos (`.env`, `secrets/`) ficam só no servidor.

Para conferir se subiu, compare o `revision` de `GET /health` com o commit.

Passo a passo, montagem do servidor, operação e rollback: [`DEPLOY.md`](DEPLOY.md).

## Documentação

- [`PROJETO-ROBO.md`](PROJETO-ROBO.md) — arquitetura, protocolo e decisões do projeto
- [`DEPLOY.md`](DEPLOY.md) — produção na VPS
- [`firmware/BOARD.md`](firmware/BOARD.md) — a placa, o display e os pinos

## Stack

TypeScript (ESM) · NestJS · React + Vite · Electron · zod · Anthropic SDK · OpenAI SDK
(Groq/NVIDIA) · Baileys · sherpa-onnx · ESP-IDF 5.5 (C) · Docker · GitHub Actions · nginx
