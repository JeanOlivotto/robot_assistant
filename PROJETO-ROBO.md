# Projeto "Robozinho" — Assistente de Voz Embarcado

> **Documento de arquitetura e plano de execução.**
> Escrito para ser consumido por humano e por agente (Claude Code) como contexto raiz do repositório.
> Versão do documento: 1.0 — Setembro/2026
> Autor: Jean | Status: planejamento fechado, pronto para Fase 1

---

## 0. Como usar este documento

Coloque este arquivo em `docs/PROJETO-ROBO.md` na raiz do monorepo e referencie-o no `CLAUDE.md`:

```md
<!-- CLAUDE.md na raiz -->
# Contexto do projeto
Leia `docs/PROJETO-ROBO.md` antes de qualquer tarefa. Ele define arquitetura,
protocolo, escopo da v1 e decisões já tomadas. Não reabra decisões marcadas
como FECHADA sem me perguntar.

# Regras de trabalho
- Monorepo pnpm workspaces. Backend em NestJS + TypeScript estrito.
- Firmware em ESP-IDF 5.x (C), não Arduino.
- Nada de lógica de IA no firmware. O device é thin client.
- Todo contrato novo entra em `packages/protocol` primeiro, depois é implementado.
```

**Convenção de decisões neste doc:**
`[FECHADA]` = não discutir de novo, já foi analisado.
`[ABERTA]` = precisa de decisão sua antes de implementar.
`[V2]` = fora do escopo da primeira versão, anotado para não esquecer.

---

## 1. Visão do produto

Um dispositivo pequeno (formato chaveiro / peso de mesa) que:

1. Ouve você falar e responde com voz.
2. Mostra um "rostinho" animado no LCD que reage ao estado (ouvindo, pensando, falando).
3. Em reunião presencial, captura o áudio da sala e envia continuamente ao servidor, que transcreve e gera resumo + itens de ação.
4. Cria e consulta compromissos e tarefas por voz.
5. Manda notificações para o celular.

**O dispositivo não pensa.** Ele é microfone + alto-falante + tela + rádio. Toda inteligência (VAD de segundo estágio, wake word, STT, NLU, LLM, TTS, integrações) vive no servidor Linux com Docker. `[FECHADA]`

### 1.1 Escopo da v1 — exatamente cinco capacidades

| # | Capacidade | Exemplo de uso |
|---|---|---|
| 1 | Conversa curta por voz | "Oi robô, que horas são?" |
| 2 | Consulta de agenda e tarefas | "O que eu tenho pra hoje?" |
| 3 | Criação de compromisso | "Marca reunião com o Fábio quinta às 14h" |
| 4 | Criação de tarefa | "Me lembra de revisar o contrato amanhã" |
| 5 | Modo reunião presencial | "Entra na reunião" → streaming → resumo no celular |

**Fora da v1 (`[V2]`):** conversa multi-turno com memória longa, identificação de quem falou (diarização por voz conhecida), controle de casa inteligente, tradução, bot que entra em sala virtual do Meet/Zoom, captura do áudio do desktop via PipeWire.

### 1.2 Critério de sucesso da v1

- Latência fim-a-fim (fim da fala → primeiro som da resposta) **< 1.5s** na rede local.
- Taxa de falso-positivo da wake word **< 2 por hora** em ambiente de escritório.
- Reunião de 60 minutos processada sem perda de áudio e resumo entregue em **< 5 min** após o fim.

---

## 2. Hardware

### 2.1 Placa atual — ESP32-C3 + LCD 1.44" `[FECHADA para v1]`

| Item | Especificação |
|---|---|
| MCU | ESP32-C3, RISC-V 32-bit single-core, até 160 MHz |
| RAM | 400 KB SRAM (sem PSRAM) |
| Flash | 4 MB |
| Rádio | Wi-Fi 2.4 GHz b/g/n, BLE 5.0 |
| Display | TFT 1.44", 128×128, SPI, controlador ST7735 (confirmar) |
| Energia | Micro USB 5V + bateria LiPo 300 mAh |
| I2S | **1 controlador**, suporta TX e RX simultâneos compartilhando BCLK/WS |
| DAC | **Não possui** — áudio de saída só via I2S externo |

**Limitações aceitas conscientemente:**

- Sem PSRAM e sem instruções DSP/SIMD → **wake word local (ESP-SR/WakeNet) é impossível**. A Espressif não suporta WakeNet no C3. Não é questão de otimização.
- 300 mAh com Wi-Fi ativo (~120–180 mA) → ~1.5–2h de streaming contínuo.
- 4 MB de flash → não há store-and-forward de reunião longa.

### 2.2 Componentes a comprar

| Item | Modelo | Faixa (BRL) | Função |
|---|---|---|---|
| Microfone I2S | **INMP441** | 20–35 | Captura digital 24-bit. Padrão de fato. |
| Mic alternativo | ICS-43434 | ~45 | Menos ruído de fundo, opcional |
| Amp + DAC I2S | **MAX98357A** | 25–40 | Resolve a ausência de DAC no C3 |
| Alto-falante | 4Ω 3W, 40 mm | ~15 | Saída de áudio |
| Botão tátil | qualquer 6×6mm | ~2 | **Debug e reset de Wi-Fi**, não uso normal |
| Fonte USB | 5V / 2A | — | Modo mesa |

**Não comprar ainda:** array de microfones, placa de beamforming, microSD. Só depois que o pipeline funcionar de ponta a ponta.

### 2.3 Ligação I2S (compartilhando clock)

O ESP-IDF 5.x permite alocar canais TX e RX no **mesmo** `i2s_port` em modo master, compartilhando BCLK e WS. Isso economiza GPIOs:

```
ESP32-C3                INMP441 (mic)          MAX98357A (amp)
────────                ─────────────          ───────────────
GPIO_BCLK  ──────┬────► SCK                ┌─► BCLK
                 └──────────────────────────┘
GPIO_WS    ──────┬────► WS                 ┌─► LRC
                 └──────────────────────────┘
GPIO_DIN   ◄──────────  SD
GPIO_DOUT  ───────────────────────────────────► DIN
GPIO_SD_MODE ─────────────────────────────────► SD (shutdown, opcional)
3V3        ──────────► VDD                 ───► VIN
GND        ──────────► GND + L/R(=GND)     ───► GND
```

- INMP441 `L/R` em GND = canal esquerdo. Fixe assim e leia só o canal L.
- MAX98357A `SD` alto = ligado. Puxar baixo entre respostas economiza energia e elimina chiado.

### 2.4 Pinout — CONFIRMADO `[FECHADA]`

Placa identificada: **SpotPear ESP32-C3 "Desktop Trinket / Mini TV" 1.44" ST7735**.
Repo oficial: `github.com/Spotpear/ESP32C3_1.44inch`

**Pinos ocupados pela placa:**

| Função | GPIO | Observação |
|---|---|---|
| LCD SCLK | **3** | SPI |
| LCD MOSI | **4** | SPI |
| LCD RST | **5** | |
| LCD DC | **0** | |
| LCD CS | **2** | ⚠️ strapping pin |
| Botão BOOT | **9** | ⚠️ strapping pin, sem pull-up externo |
| Botão KEY1 | **8** | ⚠️ strapping pin, sem pull-up externo |
| Botão KEY2 | **10** | sem pull-up externo |
| LED | **11** | ligado ao VCC da flash SPI — **não usar** |
| USB Serial/JTAG | 18/19 | nativo, não exposto |

Display: ST7735S 128×128, `colOffset=2`, `rowOffset=1`, `rotation=180`.
Backlight: sem controle por GPIO (sempre ligado). Carga LiPo via PL4054, sem API.

**GPIOs livres — exatamente 5, no header lateral:**

| Pad | GPIO | Destino no projeto |
|---|---|---|
| 1 | **GPIO1** | I2S BCLK |
| 2 | **GPIO6** | I2S WS (LRCLK) |
| 3 | **GPIO7** | I2S DIN — mic INMP441 |
| 4 | **GPIO20** | I2S DOUT — amp MAX98357A |
| 5 | **GPIO21** | MAX98357A SD_MODE (ou reserva) |
| 6 | GND | — |

Do lado oposto da PCB há pads de **3.3V** e de tensão de carga do USB.

**Cabe com folga zero.** Quatro pinos de I2S nos cinco livres, sobrando um para o shutdown do amplificador.

⚠️ **GPIO20/21 são UART0 (TX/RX) por padrão.** Para usá-los como I2S, redirecione o console para o USB Serial/JTAG nativo:

```
# sdkconfig.defaults.esp32c3
CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y
CONFIG_ESP_CONSOLE_UART_DEFAULT=n
```

Sem isso, o log do boot vai sair pelos pinos do microfone e o I2S não funciona.

⚠️ **Risco físico:** os pads são pequenos e o display é colado rente à PCB. Solda difícil, com risco de danificar o LCD com calor. Use ferro de ponta fina, temperatura moderada (~300 °C), e fio AWG30 (wire-wrap). Considere colar os fios com epóxi depois, para alívio mecânico.

**Flash:** existem variantes de 4 MB e de 16 MB (chip 25Q128JVSG). Confirme com `esptool.py -p /dev/esp32 flash_id` e ajuste `partitions.csv` — se for 16 MB, sobra espaço de sobra para OTA duplo e buffer SPIFFS.

### 2.5 Plano de migração para ESP32-S3 `[V2, mas arquitetado desde já]`

O S3 é o upgrade natural. Diferenças que importam:

| | C3 | S3 |
|---|---|---|
| Núcleos | 1 × RISC-V 160 MHz | 2 × Xtensa LX7 240 MHz |
| PSRAM | não | 2–8 MB |
| I2S | 1 controlador | 2 controladores |
| WakeNet / ESP-SR | ❌ | ✅ wake word **local** |
| Codec Opus em tempo real | inviável | viável |
| Framebuffer LCD grande | apertado | folgado |

**O que isso destrava:** wake word sem enviar áudio à rede (rádio dorme de verdade → dias de bateria), mic array de 2 canais com supressão de eco, resposta mais rápida.

**Como manter o código portável desde hoje `[FECHADA]`:**

Toda a lógica do firmware vive acima de uma camada HAL. Nenhum `#ifdef` espalhado pelo código de negócio.

```
firmware/
├── main/
│   ├── app_main.c
│   ├── core/              # lógica portável — NÃO conhece o chip
│   │   ├── state_machine.c
│   │   ├── ws_client.c
│   │   ├── audio_pipeline.c
│   │   └── face_render.c
│   └── hal/
│       ├── hal.h          # interface única
│       ├── hal_esp32c3.c  # implementação C3
│       └── hal_esp32s3.c  # implementação S3 (stub por enquanto)
```

```c
/* main/hal/hal.h — contrato estável entre core e chip */
#pragma once
#include <stdint.h>
#include <stdbool.h>

typedef enum { HAL_WAKE_VAD_LOCAL, HAL_WAKE_ONDEVICE_KW, HAL_WAKE_BUTTON } hal_wake_mode_t;

typedef struct {
    const char *chip_name;
    bool  has_psram;
    bool  has_local_wakeword;     // C3: false | S3: true
    bool  supports_opus_encode;   // C3: false | S3: true
    uint8_t i2s_controllers;
    uint16_t lcd_w, lcd_h;
    hal_wake_mode_t wake_mode;
} hal_caps_t;

const hal_caps_t *hal_caps(void);

esp_err_t hal_audio_init(uint32_t sample_rate);
size_t    hal_audio_read(int16_t *buf, size_t samples, uint32_t timeout_ms);
size_t    hal_audio_write(const int16_t *buf, size_t samples);
void      hal_audio_amp_enable(bool on);

esp_err_t hal_display_init(void);
void      hal_display_blit(const uint16_t *fb, int x, int y, int w, int h);
void      hal_display_backlight(uint8_t pct);

/* No S3 retorna true quando o WakeNet dispara.
   No C3 retorna sempre false — a wake word é resolvida no servidor. */
bool      hal_wakeword_poll(void);
```

O `core/` pergunta `hal_caps()->has_local_wakeword` e escolhe a estratégia. Trocar de placa = escrever um novo `hal_*.c` e mudar o target no build. Zero refactor de lógica.

---

## 3. Como o robô acorda — sem botão `[FECHADA]`

Você não quer botão. Solução em dois estágios:

```
┌─ Estágio 1: no ESP32 (barato, burro) ────────────────────────┐
│  Mic sempre ligado (~1.4 mA). Wi-Fi DESLIGADO.               │
│  VAD por energia RMS + zero-crossing rate — aritmética        │
│  inteira, roda folgado no C3.                                 │
│  Ring buffer circular guarda os últimos 1.5s (48 KB).         │
│                                                               │
│  Tem voz?  ── não ──► continua dormindo                       │
│      │ sim                                                    │
└──────┼────────────────────────────────────────────────────────┘
       ▼
┌─ Estágio 2: no servidor (caro, esperto) ─────────────────────┐
│  ESP32 liga Wi-Fi e envia o ring buffer INTEIRO + 2s a mais.  │
│  Servidor roda openWakeWord procurando "oi robô".             │
│                                                               │
│  Achou?  ── não ──► descarta, manda device dormir de novo     │
│      │ sim                                                    │
│      ▼                                                        │
│  Sessão aberta. Rostinho muda para "listening".               │
└───────────────────────────────────────────────────────────────┘
```

**Por que o ring buffer é obrigatório:** sem ele, o servidor recebe "…obô, que horas são" — o começo da frase se perde enquanto o VAD decide. Enviando 1.5s de histórico, a frase chega íntegra.

**Custos honestos:**
- Latência extra de 300–600 ms para reassociar o Wi-Fi. Perceptível, aceitável.
- Em sala barulhenta (escritório com gente falando), o rádio liga toda hora → bateria cai para 4–6h.
- Em sala silenciosa → dias.

**Modo mesa (USB conectado):** ignora o VAD, mantém streaming contínuo e WebSocket vivo. Mais responsivo, energia não importa.

### 3.1 Papel do botão (que você não vai usar no dia a dia)

Deixe o pad exposto no case. Serve para:
- `segurar 8s` → apaga NVS e sobe o portal SoftAP de configuração de Wi-Fi.
- Debug quando o VAD estiver dando problema na semana 3 de desenvolvimento.

### 3.2 Perfis de energia

| | Modo Chaveiro (bateria) | Modo Mesa (USB) |
|---|---|---|
| Estado base | light sleep, mic+VAD ativos | acordado, WS persistente |
| Wi-Fi | liga sob demanda | sempre |
| Tela | apaga após 10s | rostinho sempre ativo |
| Alertas de compromisso | **vão para o celular via ntfy** | tela + voz |
| Reunião longa | ❌ (exige USB) | ✅ |
| Autonomia | horas a dias | infinita |

Decisão de produto: o robô não precisa te alertar enquanto está no bolso — o celular já faz isso melhor.

---

## 4. Rede fora de casa `[FECHADA]`

O C3 só tem Wi-Fi 2.4 e BLE. Numa reunião no cliente não existe rede conhecida.

**Solução v1: hotspot do celular.** Provisione o SSID do seu hotspot como rede prioritária.

Opções descartadas e por quê:
- **BLE como gateway** — BLE 5.0 no C3 entrega ~100–200 kbps reais. PCM 16k/16-bit são 256 kbps. Não cabe sem compressão pesada, e exige app Android dedicado. Escopo explodido.
- **Store-and-forward na flash** — sobram ~2.5 MB. Com ADPCM dá ~5 minutos. Inútil para reunião.

### 4.1 Provisionamento de Wi-Fi

- Lista de até 5 redes em NVS, com prioridade e fallback automático.
- Primeira boot (ou reset de 8s) → SoftAP `robo-setup` + portal cativo em `192.168.4.1`.
- Reconexão com backoff exponencial: 1s, 2s, 4s, 8s, 30s (teto).

---

## 5. Codec de áudio `[FECHADA]`

| | PCM 16-bit | **IMA ADPCM 4:1** | Opus |
|---|---|---|---|
| Taxa @16 kHz mono | 256 kbps | **64 kbps** | 16–32 kbps |
| CPU no C3 | zero | desprezível (~20 linhas) | inviável |
| Qualidade p/ STT | referência | perda mínima | boa |

**v1 usa IMA ADPCM.** Menos bytes = menos tempo de rádio ligado = mais bateria. Opus fica para o S3 `[V2]`.

- **Uplink** (device → servidor): ADPCM, blocos de 512 amostras.
- **Downlink** (servidor → device, TTS): ADPCM também — decodificar é ainda mais barato que codificar.
- Formato canônico em todo o pipeline: **16 kHz, mono, 16-bit LE**.

---

## 6. Arquitetura geral

```
┌──────────────────────┐
│      ESP32-C3        │   WebSocket (ws://)
│  mic + amp + LCD     │   texto = JSON de controle
│  VAD local           │◄──┐binário = áudio ADPCM
└──────────┬───────────┘   │
           │               │
           ▼               │
┌──────────────────────────┴───────────────────────────┐
│           apps/gateway  —  NestJS                     │
│  • WS server + autenticação por token de device       │
│  • Máquina de estados da sessão                       │
│  • Roteia áudio para os workers                       │
└──────────┬───────────────────────────────────────────┘
           │ BullMQ (Redis)
           ▼
┌──────────────────────────────────────────────────────┐
│           apps/worker  —  Node + Python sidecars      │
│  ┌────────────┐  ┌──────────┐  ┌──────┐  ┌────────┐  │
│  │openWakeWord│─►│Silero VAD│─►│ STT  │─►│ NLU +  │  │
│  │  (wake)    │  │(fim fala)│  │Whisper│ │ LLM FC │  │
│  └────────────┘  └──────────┘  └──────┘  └───┬────┘  │
│                                               │       │
│                              ┌────────────────▼────┐  │
│                              │  Piper TTS (pt-BR)  │  │
│                              └─────────────────────┘  │
└──────────┬───────────────────────────────────────────┘
           │
   ┌───────┼────────────┬──────────────┬──────────────┐
   ▼       ▼            ▼              ▼              ▼
Postgres  Radicale   Vikunja        ntfy          MinIO
+pgvector (CalDAV)   (tarefas)   (push celular)  (áudio bruto)
```

### 6.1 Stack — decisões `[FECHADA]`

| Camada | Escolha | Justificativa |
|---|---|---|
| Gateway | NestJS + `ws` puro (**não** socket.io) | Seu domínio. socket.io adiciona overhead de framing inútil para binário. |
| Fila | BullMQ + Redis | Transcrever 1h é job longo, não request HTTP. |
| Wake word | **openWakeWord** (ONNX, CPU) | Treinável com sua própria voz, roda em CPU. |
| VAD servidor | **Silero VAD** (ONNX) | Decide fim de fala com precisão bem maior que RMS. |
| STT comandos | `faster-whisper` **small** pt | <1s em CPU, suficiente para frases curtas. |
| STT reunião | `faster-whisper` **large-v3** (+ pyannote `[V2]`) | Qualidade e timestamps. Roda em batch, latência não importa. |
| NLU | LLM com **function calling** | Intent + slots num passo só. Sem regex, sem treinar classificador. |
| Resumo | map-reduce por chunks de ~10 min | Reunião longa não cabe em contexto único. |
| TTS | **Piper** voz pt-BR (`pt_BR-faber-medium`) | Local, ~50ms, CPU, sem custo por caractere. |
| Push celular | **ntfy** self-hosted | 1 container. Sem Firebase, sem SDK, sem conta de serviço. |
| Calendário | **Radicale** (CaldAV) | 1 container. Sincroniza no Android via DAVx5. |
| Tarefas | **Vikunja** | API REST limpa, self-hosted. |
| Banco | Postgres 16 + **pgvector** | Busca semântica em reuniões antigas `[V2]`. |
| Áudio bruto | MinIO (ou disco) | Reprocessar sem pedir o áudio de novo. |

---

## 7. Protocolo `robo-ws/1` `[FECHADA — implementar primeiro]`

**Esta é a primeira coisa a codar.** Com o contrato definido, ESP32, cliente web de teste e agente de desktop falam a mesma língua. O hardware vira só mais um cliente.

Vive em `packages/protocol` como tipos TypeScript + um header C gerado.

### 7.1 Transporte

- WebSocket em `ws://host:8080/device?token=<device_token>`
- **Frames de texto** = JSON de controle
- **Frames binários** = áudio
- Heartbeat: device envia `ping` a cada 15s; servidor derruba após 45s sem tráfego.

### 7.2 Frame binário

```
byte[0]      : magic/tipo
               0xA0 = audio_up   (device → servidor)
               0xA1 = audio_down (servidor → device, TTS)
byte[1]      : flags
               bit0 = 1 → primeiro frame do enunciado
               bit1 = 1 → último frame do enunciado
byte[2..3]   : seq (uint16 LE, wrap-around)
byte[4..7]   : reservado (0)
byte[8..]    : payload ADPCM (bloco de 512 amostras → 260 bytes)
```

Header fixo de 8 bytes mantém o payload alinhado — importante para DMA no ESP32.

### 7.3 Mensagens de controle (JSON)

Campo `t` = tipo. Todas carregam `ts` (epoch ms).

**Device → Servidor**

```jsonc
{ "t":"hello", "dev":"robo-01", "fw":"0.1.0", "chip":"esp32c3",
  "caps":{ "codec":["adpcm"], "sr":16000, "wake":"vad_local" } }

{ "t":"wake_candidate", "pre_ms":1500 }   // VAD disparou, áudio vindo a seguir

{ "t":"utt_end" }                          // device parou de captar

{ "t":"meeting_start" }                    // só via comando do servidor
{ "t":"meeting_chunk_ack", "n":42 }

{ "t":"battery", "mv":3820, "usb":false }
{ "t":"ping" }
{ "t":"error", "code":"i2s_read_fail", "detail":"..." }
```

**Servidor → Device**

```jsonc
{ "t":"hello_ack", "session":"uuid", "tz":"America/Sao_Paulo" }

{ "t":"wake_result", "ok":true, "score":0.92 }
// ok:false → device volta a dormir imediatamente

{ "t":"state", "v":"idle|listening|thinking|speaking|meeting|alert|error" }

{ "t":"tts_begin", "codec":"adpcm", "sr":16000, "text":"São 14 e trinta" }
{ "t":"tts_end" }

{ "t":"display", "mode":"alert", "title":"Reunião Fábio", "sub":"em 10 min", "ttl_ms":8000 }

{ "t":"meeting_state", "v":"recording|uploading|done", "elapsed_s":1820 }

{ "t":"sleep", "ms":0 }                    // 0 = dormir até próximo VAD
{ "t":"ota", "version":"0.8.0", "url":"https://.../api/device/firmware.bin?k=...",
  "sha256":"...", "size":1133120 }   // atualização pelo Wi-Fi (ver 7.6)
{ "t":"pong" }
```

### 7.6 Atualização de firmware pelo Wi-Fi (OTA)

Sem cabo: o robô baixa a versão nova sozinho e reinicia nela.

```
  idf.py build                      firmware/build/robo.bin
        │
        ▼
  node tools/publish-firmware.mjs   POST /api/firmware (APP_TOKEN, corpo = o .bin)
        │                           o servidor lê a versão de dentro do binário
        ▼                           (esp_app_desc) e guarda em DATA_DIR/firmware/
  gateway
        │  no `hello`, compara o `fw` do robô com a versão publicada
        ▼
  { "t":"ota", version, url, sha256, size }
        │
        ▼
  robô: baixa → confere o sha256 → grava na partição livre → reinicia
        │
        ▼
  no boot, a imagem sobe "em teste"; ela só é confirmada quando o hello_ack chega.
  Se não chegar em 5 min, o bootloader volta para a versão anterior sozinho.
```

Detalhes que importam:

- **O primeiro flash é por cabo.** Uma versão sem `core/ota.c` não sabe se atualizar — o OTA
  vale a partir da 0.8.0.
- **Duas partições** (`ota_0`/`ota_1`, 3 MB cada): a versão que está rodando nunca é apagada,
  então queda de luz no meio do download não deixa o robô sem firmware.
- **A URL leva uma chave derivada** do `DEVICE_TOKEN` (`?k=…`), não o token — ela aparece em log
  de proxy e não deve valer como credencial.
- **Voltar atrás** é publicar o .bin antigo: o robô aceita versão diferente, não só maior.
- Falhou? O robô espera 30 min antes de tentar a mesma versão de novo, e o erro aparece no log
  do gateway (`ota_status`).

### 7.4 Máquina de estados do device

```
                 ┌──────────────────────────────┐
                 │            BOOT              │
                 │  NVS → Wi-Fi → WS → hello    │
                 └──────────────┬───────────────┘
                                ▼
     ┌──────────────────────► IDLE ◄──────────────────────┐
     │                  (mic+VAD, Wi-Fi off)              │
     │                         │ VAD dispara              │
     │                         ▼                          │
     │                    WAKE_PENDING                    │
     │              (liga Wi-Fi, envia ring buffer)       │
     │                         │                          │
     │        wake_result:false│  wake_result:true        │
     └─────────────────────────┤                          │
                               ▼                          │
                          LISTENING ──utt_end──► THINKING │
                                                     │    │
                                                     ▼    │
                                                 SPEAKING─┘
                                                 (tts_end)

      qualquer estado ──meeting_start──► MEETING ──meeting_stop──► IDLE
      erro de rede/I2S ──────────────► ERROR ──backoff──► BOOT
```

### 7.5 Regra de ouro

> Nenhuma feature entra sem estar no `packages/protocol`.
> O tipo TS é a fonte da verdade; o header C é gerado a partir dele.

---

## 8. Estrutura do monorepo

```
robo/
├── CLAUDE.md
├── docs/
│   └── PROJETO-ROBO.md          # este arquivo
├── pnpm-workspace.yaml
├── docker-compose.yml
├── .env.example
│
├── packages/
│   ├── protocol/                # ⭐ FONTE DA VERDADE
│   │   ├── src/
│   │   │   ├── messages.ts      # tipos de controle (zod schemas)
│   │   │   ├── binary.ts        # encode/decode do header de 8 bytes
│   │   │   ├── adpcm.ts         # IMA ADPCM em TS (referência + cliente web)
│   │   │   └── states.ts        # enum de estados
│   │   └── scripts/gen-c-header.ts   # gera firmware/main/core/protocol.h
│   └── shared/                  # tipos de domínio (Event, Task, Meeting)
│
├── apps/
│   ├── gateway/                 # NestJS — WS + REST
│   │   └── src/
│   │       ├── ws/              # DeviceGateway, SessionManager
│   │       ├── auth/            # token de device
│   │       ├── audio/           # ring buffer por sessão, ADPCM decode
│   │       └── queue/           # produtores BullMQ
│   │
│   ├── worker/                  # NestJS standalone — consumidores BullMQ
│   │   └── src/
│   │       ├── jobs/            # wake, transcribe-utterance, transcribe-meeting, summarize
│   │       ├── nlu/             # function calling, definição de tools
│   │       ├── skills/          # implementação das intents
│   │       └── integrations/    # caldav, vikunja, ntfy
│   │
│   ├── ai-sidecar/              # Python + FastAPI (o ecossistema de áudio é Python)
│   │   ├── main.py
│   │   ├── routes/wake.py       # openWakeWord
│   │   ├── routes/vad.py        # Silero
│   │   ├── routes/stt.py        # faster-whisper
│   │   └── routes/tts.py        # Piper
│   │
│   └── web-client/              # ⭐ Vite + TS — SIMULA O ROBÔ NO NAVEGADOR
│       └── src/                 # getUserMedia → mesmo protocolo WS
│
├── firmware/
│   ├── BOARD.md                 # pinout confirmado
│   ├── CMakeLists.txt
│   ├── sdkconfig.defaults.esp32c3
│   ├── sdkconfig.defaults.esp32s3
│   └── main/
│       ├── app_main.c
│       ├── core/                # portável
│       └── hal/                 # específico do chip
│
└── tools/
    └── pin-scan/                # sketch de descoberta de GPIO
```

**Por que `web-client` existe e por que ele é crítico:** ele permite desenvolver, testar e iterar **todo o backend sem hardware nenhum**. Debugar I2S + Wi-Fi + protocolo + STT ao mesmo tempo é inferno. Com o cliente web você itera em segundos e chega no firmware com o servidor já sólido.

**Por que Python no `ai-sidecar` e não tudo em Node:** faster-whisper, Silero, openWakeWord e Piper são todos Python/ONNX. Forçar Node aqui é lutar contra o ecossistema sem ganho. O sidecar é um container com API HTTP interna — o `worker` chama via `fetch`.

---

## 9. Pipeline de processamento

### 9.1 Comando de voz (caminho quente, alvo < 1.5s)

```
device VAD dispara
  └─► gateway recebe ring buffer (1.5s) + stream
        └─► POST ai-sidecar /wake       ~80 ms   openWakeWord
              ok? ────► não: {wake_result:false}, device dorme
              │ sim
              └─► {state: listening}, stream continua
                    └─► ai-sidecar /vad em janelas    detecta fim de fala
                          └─► {state: thinking}
                                └─► /stt (whisper small)      ~400 ms
                                      └─► NLU function calling ~500 ms
                                            └─► skill executa   ~100 ms
                                                  └─► /tts Piper ~150 ms
                                                        └─► {tts_begin} + frames 0xA1
```

**Otimização obrigatória: streaming do TTS.** Não espere o Piper terminar a frase inteira. Gere por sentença e comece a enviar o primeiro bloco assim que existir. O usuário percebe ~300 ms em vez de ~1.2 s.

### 9.2 Reunião presencial (caminho frio)

```
"entra na reunião"
  └─► {meeting_state: recording}, device entra em streaming contínuo
        └─► gateway grava .wav em MinIO, chunks de 30s
              └─► a cada 10 min: job transcribe-meeting-chunk (large-v3)
                    └─► transcript parcial → Postgres
"pode encerrar"  (ou 3 min de silêncio, ou USB desconectado)
  └─► job summarize-meeting
        ├─► map:    resumo de cada chunk de ~10 min
        ├─► reduce: síntese final + tópicos
        ├─► extract: action items via function calling estruturado
        ├─► grava em Postgres
        ├─► cria tarefas no Vikunja
        └─► POST ntfy → celular
```

**Por que chunk de 30s no upload e 10 min na transcrição:** 30s limita perda se a rede cair; 10 min dá contexto suficiente ao Whisper para pontuar e não cortar frases no meio.

### 9.3 Schema de extração de action items

```jsonc
// tool definition para o LLM
{
  "name": "registrar_itens_reuniao",
  "input_schema": {
    "type": "object",
    "properties": {
      "titulo":   { "type": "string" },
      "resumo":   { "type": "string", "description": "3-6 parágrafos" },
      "topicos":  { "type": "array", "items": { "type": "string" } },
      "decisoes": { "type": "array", "items": { "type": "string" } },
      "acoes": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "titulo":      { "type": "string" },
            "responsavel": { "type": "string" },
            "prazo":       { "type": "string", "description": "ISO 8601 ou null" },
            "prioridade":  { "enum": ["baixa","media","alta"] },
            "citacao":     { "type": "string", "description": "trecho literal que originou" }
          },
          "required": ["titulo","prioridade"]
        }
      }
    },
    "required": ["titulo","resumo","topicos","acoes"]
  }
}
```

O campo `citacao` é o que te deixa auditar quando o resumo alucinar. Não é opcional na prática.

---

## 10. Intents da v1

Definidas como tools de function calling em `apps/worker/src/nlu/tools.ts`.

| Intent | Slots | Exemplo |
|---|---|---|
| `consultar_agenda` | `periodo` (hoje/amanhã/semana/data) | "o que tenho pra hoje" |
| `criar_evento` | `titulo`, `inicio`, `duracao_min`, `participantes[]` | "marca reunião com o Fábio quinta às 14h" |
| `criar_tarefa` | `titulo`, `prazo?`, `prioridade?` | "me lembra de revisar o contrato amanhã" |
| `listar_tarefas` | `filtro` (hoje/atrasadas/todas) | "quais tarefas estão atrasadas" |
| `iniciar_reuniao` | — | "entra na reunião" |
| `encerrar_reuniao` | — | "pode encerrar" |
| `conversa` | `pergunta` (fallback) | "que horas são" |

**Regra de desambiguação de datas `[FECHADA]`:** o LLM **nunca** calcula data. Ele devolve expressão relativa (`"quinta"`, `"amanhã 14h"`) e o código resolve com `date-fns-tz` + `America/Sao_Paulo`. LLM errando fuso horário e semana é fonte garantida de bug silencioso.

**Confirmação antes de escrever `[FECHADA]`:** criar evento ou tarefa sempre passa por confirmação falada — *"Reunião com Fábio, quinta dia 17, às 14h. Confirma?"*. Escrita sem confirmação com STT imperfeito polui sua agenda em uma semana.

---

## 11. Banco de dados

```sql
-- devices
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  chip          text NOT NULL,
  fw_version    text,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- sessões de interação por voz
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES devices(id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  wake_score   real
);

-- cada enunciado (fala do usuário + resposta)
CREATE TABLE utterances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  audio_uri    text,
  transcript   text,
  intent       text,
  slots        jsonb,
  response     text,
  latency_ms   integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- reuniões
CREATE TABLE meetings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid REFERENCES devices(id),
  title        text,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  audio_uri    text,
  status       text NOT NULL DEFAULT 'recording',  -- recording|transcribing|summarizing|done|failed
  summary      text,
  topics       jsonb,
  decisions    jsonb
);

-- segmentos transcritos
CREATE TABLE meeting_segments (
  id           bigserial PRIMARY KEY,
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  start_ms     integer NOT NULL,
  end_ms       integer NOT NULL,
  speaker      text,                    -- [V2] diarização
  text         text NOT NULL,
  embedding    vector(1024)             -- [V2] busca semântica
);
CREATE INDEX ON meeting_segments (meeting_id, start_ms);

-- itens de ação extraídos
CREATE TABLE action_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    uuid REFERENCES meetings(id) ON DELETE CASCADE,
  title         text NOT NULL,
  assignee      text,
  due_at        timestamptz,
  priority      text NOT NULL DEFAULT 'media',
  quote         text,
  external_id   text,                   -- id no Vikunja
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

---

## 12. Infraestrutura

```yaml
# docker-compose.yml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_PASSWORD: ${PG_PASSWORD}
      POSTGRES_DB: robo
    volumes: [pgdata:/var/lib/postgresql/data]

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes: [redisdata:/data]

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
    volumes: [miniodata:/data]

  ai-sidecar:
    build: ./apps/ai-sidecar
    environment:
      WHISPER_MODEL_FAST: small
      WHISPER_MODEL_QUALITY: large-v3
      PIPER_VOICE: pt_BR-faber-medium
    volumes: [models:/models]
    # descomentar se tiver GPU:
    # deploy: { resources: { reservations: { devices: [{ capabilities: [gpu] }] } } }

  gateway:
    build: { context: ., dockerfile: apps/gateway/Dockerfile }
    ports: ["8080:8080"]
    depends_on: [postgres, redis]

  worker:
    build: { context: ., dockerfile: apps/worker/Dockerfile }
    depends_on: [postgres, redis, ai-sidecar]

  ntfy:
    image: binwiederhier/ntfy
    command: serve
    ports: ["8081:80"]
    volumes: [ntfydata:/var/lib/ntfy]

  radicale:
    image: tomsquest/docker-radicale
    ports: ["5232:5232"]
    volumes: [radicaledata:/data]

  vikunja:
    image: vikunja/vikunja
    ports: ["3456:3456"]
    environment:
      VIKUNJA_DATABASE_TYPE: postgres
      VIKUNJA_DATABASE_HOST: postgres
    depends_on: [postgres]

volumes: { pgdata:, redisdata:, miniodata:, ntfydata:, radicaledata:, models: }
```

**Nota sobre desempenho:** `large-v3` em CPU transcreve aproximadamente em tempo real ou mais lento — uma reunião de 1h pode levar 40–90 min num servidor sem GPU. Se isso for inaceitável, opções em ordem de custo: usar `medium` em vez de `large-v3`, rodar `distil-whisper`, ou pagar API de transcrição só para reuniões longas. `[ABERTA — depende do hardware do seu servidor]`

No Android: instale o app **ntfy** e inscreva-se no tópico; instale **DAVx5** e aponte para o Radicale para o calendário cair no app nativo.

---

## 13. O rostinho

Tela de 128×128 em RGB565 = **32 KB** de framebuffer. Cabe folgado nos 400 KB de SRAM.

**Desenhe procedural, não com sprites.** Elipses, arcos e retângulos arredondados via LovyanGFX. Ocupa quase nada de flash e permite interpolar entre estados com easing.

| Estado | Rosto |
|---|---|
| `idle` | olhos abertos, piscada aleatória a cada 3–6s, leve drift do olhar |
| `listening` | olhos arregalados + barra de nível de áudio (feedback real de que o mic captou) |
| `thinking` | olhos fechados em arco, três pontinhos pulsando |
| `speaking` | **boca animada pelo envelope RMS do PCM que está tocando** |
| `meeting` | olhos com "fone", timer decorrido, indicador de upload |
| `alert` | olhos de exclamação, cor de destaque, texto do compromisso |
| `error` | olhos em X + código curto |

A boca sincronizada com o áudio é o detalhe que faz o boneco parecer vivo — e sai de graça: você já tem o buffer PCM em mãos antes de mandar para o I2S.

```c
// core/face_render.c — sincronia labial
static uint8_t mouth_open_from_pcm(const int16_t *buf, size_t n) {
    uint64_t acc = 0;
    for (size_t i = 0; i < n; i++) acc += (int32_t)buf[i] * buf[i];
    uint32_t rms = (uint32_t)sqrt((double)acc / n);
    uint32_t v = (rms * 255) / 8000;            // 8000 ≈ RMS de fala normal
    return v > 255 ? 255 : (uint8_t)v;
}
```

**Biblioteca:** LovyanGFX (mais rápida que TFT_eSPI no C3, com sprite e DMA decentes). **LVGL é overkill absoluto aqui** — não use.

**Orçamento de CPU:** renderize a 20–25 FPS, não 60. O core RISC-V é single-core e precisa dele para I2S e Wi-Fi. Use sprite em RAM + blit por DMA; nunca desenhe direto no display.

---

## 14. Ambiente de desenvolvimento no Arch Linux

### 14.1 Toolchain ESP-IDF

```bash
# dependências
sudo pacman -S --needed git cmake ninja ccache dfu-util libusb python python-pip

# ESP-IDF 5.x (instalação manual — mais controle que o AUR)
mkdir -p ~/esp && cd ~/esp
git clone -b v5.3 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh esp32c3,esp32s3          # instala toolchain dos dois targets

# ativar no shell (adicione um alias no seu .zshrc/.bashrc)
alias get_idf='. $HOME/esp/esp-idf/export.sh'
```

> Não coloque `export.sh` direto no rc do shell — ele polui o PATH de toda sessão. Use o alias.

### 14.2 Permissão de porta serial

No Arch o grupo é **`uucp`**, não `dialout`:

```bash
sudo usermod -aG uucp $USER
# logout/login ou: newgrp uucp
```

Regra udev para nome estável:

```bash
sudo tee /etc/udev/rules.d/99-esp.rules << 'EOF'
# USB Serial/JTAG nativo do ESP32-C3/S3
SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", ATTRS{idProduct}=="1001", MODE="0660", GROUP="uucp", SYMLINK+="esp32"
# CH340 (comum em placas com conversor externo)
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", MODE="0660", GROUP="uucp", SYMLINK+="esp32"
# CP2102
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", MODE="0660", GROUP="uucp", SYMLINK+="esp32"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

### 14.3 Identificar a placa

```bash
# antes e depois de plugar
dmesg -w | grep -i tty
ls -l /dev/ttyACM* /dev/ttyUSB* /dev/esp32 2>/dev/null
lsusb
```

- `/dev/ttyACM0` → **USB Serial/JTAG nativo** do ESP32-C3 (VID `303a`)
- `/dev/ttyUSB0` → conversor externo CH340 ou CP2102

Isso muda o baud de gravação e se o reset automático funciona. Anote em `firmware/BOARD.md`.

### 14.4 Primeiro build e gravação

```bash
get_idf
cd firmware

idf.py set-target esp32c3
idf.py menuconfig          # Wi-Fi, partições, log level
idf.py build

# gravar + abrir monitor (Ctrl+] para sair)
idf.py -p /dev/esp32 flash monitor

# se o reset automático falhar (comum em placas baratas):
# segure BOOT, dê um toque em RST, solte BOOT, e rode o flash
idf.py -p /dev/esp32 -b 460800 flash
```

### 14.5 Diagnóstico rápido

```bash
# ver chip, MAC, tamanho de flash
esptool.py -p /dev/esp32 chip_id
esptool.py -p /dev/esp32 flash_id

# apagar tudo quando o bootloader travar
esptool.py -p /dev/esp32 erase_flash

# decodificar backtrace de panic
idf.py monitor    # o monitor já decodifica automaticamente
```

### 14.6 Tabela de partições

4 MB é apertado. Sem OTA na v1, com espaço reservado para OTA na v2:

```csv
# firmware/partitions.csv
# Name,   Type, SubType, Offset,   Size
nvs,      data, nvs,     0x9000,   0x6000
phy_init, data, phy,     0xf000,   0x1000
factory,  app,  factory, 0x10000,  0x200000
storage,  data, spiffs,  0x210000, 0x1E0000
```

Em `sdkconfig.defaults.esp32c3`:
```
CONFIG_PARTITION_TABLE_CUSTOM=y
CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"
CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y
CONFIG_FREERTOS_HZ=1000
CONFIG_ESP_MAIN_TASK_STACK_SIZE=8192
```

### 14.7 Alternativa: PlatformIO

Se preferir DX mais simples no começo:

```ini
; platformio.ini
[env:esp32c3]
platform = espressif32
board = esp32-c3-devkitm-1
framework = espidf
monitor_speed = 115200
upload_speed = 460800
build_flags = -DBOARD_ESP32C3

[env:esp32s3]
platform = espressif32
board = esp32-s3-devkitc-1
framework = espidf
board_build.arduino.memory_type = qio_opi
build_flags = -DBOARD_ESP32S3 -DBOARD_HAS_PSRAM
```

Recomendação: **ESP-IDF puro**. Você vai precisar de controle fino de driver I2S e buffers DMA — PlatformIO com framework espidf funciona, mas adiciona uma camada a mais para debugar.

---

## 15. Roadmap

### Fase 0 — Protocolo e esqueleto (2–3 dias, zero hardware)

- [ ] `packages/protocol` com zod schemas + encode/decode binário + ADPCM em TS
- [ ] Script `gen-c-header.ts` gerando `protocol.h`
- [ ] `docker-compose.yml` subindo e saudável
- [ ] `apps/gateway` aceitando WS, validando token, ecoando áudio de volta
- [ ] **Aceite:** `web-client` conecta, grava 3s, recebe o mesmo áudio de volta e toca

### Fase 1 — Pipeline de voz completo (1–2 semanas, zero hardware)

- [ ] `ai-sidecar` com `/wake`, `/vad`, `/stt`, `/tts`
- [ ] Wake word "oi robô" treinada no openWakeWord com sua voz
- [ ] NLU com function calling + 7 intents
- [ ] Integração Radicale (CalDAV) e Vikunja
- [ ] ntfy funcionando no celular
- [ ] Fluxo de confirmação falada antes de escrever
- [ ] **Aceite:** pelo `web-client`, "oi robô, o que tenho pra hoje" responde por voz em **< 1.5s**

> **Aqui está toda a complexidade real do projeto.** Não avance para o firmware antes deste aceite.

### Fase 2 — Modo reunião (1–2 semanas, ainda sem hardware)

- [ ] Upload em chunks de 30s → MinIO
- [ ] Job de transcrição em blocos de 10 min
- [ ] Map-reduce de resumo
- [ ] Extração estruturada de action items com `citacao`
- [ ] Criação automática de tarefas no Vikunja + push ntfy
- [ ] Recuperação: reconexão no meio da reunião não perde áudio
- [ ] **Aceite:** 45 min de áudio real → resumo utilizável + ≥3 action items corretos

### Fase 3 — Hardware básico (1 semana)

- [ ] Rodar `tools/pin-scan`, preencher `firmware/BOARD.md`
- [ ] Soldar INMP441 + MAX98357A
- [ ] "Blink" do rostinho: renderizar os 7 estados em loop, sem rede
- [ ] Gravar 5s fixos no boot e tocar de volta (valida I2S TX+RX)
- [ ] **Aceite:** o robô grava e reproduz a própria voz com qualidade limpa

> Valide áudio isolado da rede. Se misturar as duas coisas, você não vai saber de onde vem o chiado.

### Fase 4 — Firmware conectado (1–2 semanas)

- [ ] Provisionamento Wi-Fi via SoftAP + NVS
- [ ] Cliente WS + máquina de estados completa
- [ ] ADPCM encode/decode em C
- [ ] Ring buffer de 1.5s + VAD por RMS/ZCR
- [ ] Sincronia labial pelo RMS do PCM de saída
- [ ] Modo mesa vs modo bateria (detecção de USB)
- [ ] **Aceite:** as 5 capacidades da v1 funcionam no dispositivo físico

### Fase 5 — Endurecimento

- [ ] Medição real de consumo (multímetro em série)
- [ ] Backoff de reconexão e recuperação de falha de I2S
- [ ] Telemetria de latência por etapa em `utterances.latency_ms`
- [ ] Ajuste de threshold do VAD com dados reais
- [x] OTA — atualização pelo Wi-Fi (seção 7.6)

### Fase 6 — Migração S3 `[V2]`

- [ ] `hal_esp32s3.c`
- [ ] WakeNet local → rádio desligado no idle
- [ ] Opus substituindo ADPCM
- [ ] Mic array de 2 canais + AEC (falar por cima dele)

---

## 16. Riscos e mitigações

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Danificar o LCD ao soldar os 5 pads | **alta** | Pads minúsculos, display colado rente. Ponta fina, ~300 °C, AWG30, alívio com epóxi |
| Chiado/ruído no INMP441 | alta | Fios curtos, GND sólido, capacitor de 100nF no VDD, longe da antena Wi-Fi |
| Wake word com falso-positivo | média | Treinar com **sua** voz + amostras negativas do seu ambiente; threshold ajustável |
| `large-v3` lento demais em CPU | média | Fallback para `medium` ou `distil-whisper`; medir na Fase 2 |
| Bateria de 300 mAh insuficiente | **alta** | Aceito por design: reunião exige USB. Modo chaveiro é só para comandos curtos |
| Reconexão Wi-Fi perde áudio de reunião | média | Buffer de 30s na RAM do device + retry de chunk com `seq` |
| LLM alucinando action items | média | Campo `citacao` obrigatório + confirmação antes de criar tarefa |
| Latência > 1.5s | média | Streaming de TTS por sentença; medir cada etapa desde a Fase 1 |

---

## 17. Erros a não cometer

1. **Não comece pelo firmware.** Debugar I2S + Wi-Fi + protocolo + STT ao mesmo tempo é inferno. O `web-client` existe para isso.
2. **Não acumule áudio no ESP32.** Stream em chunks pequenos; o buffer grande é no servidor. 400 KB de RAM acabam instantaneamente.
3. **Não deixe o LLM calcular datas.** Ele devolve expressão relativa; o código resolve com timezone.
4. **Não escreva na agenda sem confirmação falada.** STT imperfeito + escrita automática = agenda poluída em uma semana.
5. **Não use LVGL.** Overkill para 7 estados desenhados proceduralmente.
6. **Não espalhe `#ifdef BOARD_*` pelo código.** Tudo atrás do HAL, senão a migração para o S3 vira reescrita.
7. **Não renderize a 60 FPS.** 20–25 é suficiente e o core é single-core.

---

## 18. Decisões abertas

| # | Decisão | Impacto |
|---|---|---|
| 1 | **Servidor tem GPU?** | Define `large-v3` vs `medium` vs API paga para reunião |
| 2 | **LLM: local (Qwen/Llama) ou API (Claude/GPT)?** | Local = zero custo e privacidade, exige VRAM. API = melhor function calling, custo por uso |
| ~~3~~ | ~~Pinout da placa~~ | ✅ **RESOLVIDO** — ver seção 2.4 |
| ~~4~~ | ~~Android ou iOS?~~ | ✅ **iPhone 17.** ntfy tem app nativo iOS (funciona). Calendário: usar o app nativo iOS com conta CalDAV apontando para o Radicale — iOS suporta CalDAV nativamente, sem app extra. Vikunja via PWA. |

---

## 19. Próximo comando

```bash
mkdir robo && cd robo
git init
pnpm init
# depois: colar este arquivo em docs/PROJETO-ROBO.md, criar o CLAUDE.md da seção 0,
# e pedir ao Claude Code: "implemente a Fase 0 conforme docs/PROJETO-ROBO.md"
```
