/**
 * Gera firmware/main/core/protocol.h a partir dos tipos TS.
 * O TS é a fonte da verdade (seção 7.5 do doc) — nunca edite o .h à mão.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUTTON_EVENTS,
  BUTTON_IDS,
  DEVICE_MESSAGE_TYPES,
  DEVICE_STATES,
  DISPLAY_MODES,
  FACES,
  LIMITS,
  OTA_PHASES,
  PROTOCOL,
  SERVER_MESSAGE_TYPES,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../firmware/main/core/protocol.h');

const ident = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function cEnum(prefix: string, type: string, values: readonly string[]): string {
  const fn = type.replace(/_t$/, '');
  const members = values.map((v) => `    ${prefix}_${ident(v)},`).join('\n');
  const names = values.map((v) => `"${v}"`).join(', ');
  return `typedef enum {
${members}
    ${prefix}__COUNT
} ${type};

static inline const char *${fn}_name(${type} v)
{
    static const char *const names[] = { ${names} };
    return (unsigned)v < ${prefix}__COUNT ? names[v] : "?";
}

/* Retorna -1 se o nome não existir. */
static inline int ${fn}_from_name(const char *s)
{
    for (int i = 0; i < ${prefix}__COUNT; i++) {
        if (strcmp(s, ${fn}_name((${type})i)) == 0) return i;
    }
    return -1;
}
`;
}

const defines = (prefix: string, values: readonly string[]) =>
  values.map((v) => `#define ${prefix}_${ident(v)} "${v}"`).join('\n');

const header = `/*
 * GERADO por packages/protocol/scripts/gen-c-header.ts — NÃO EDITE.
 * Rode \`pnpm gen:c\` na raiz depois de mudar packages/protocol.
 */
#pragma once

#include <string.h>

#define ROBO_PROTOCOL "${PROTOCOL}"

${Object.entries(LIMITS)
  .map(([k, v]) => `#define ROBO_${k} ${v}`)
  .join('\n')}

/* Device → Servidor */
${defines('ROBO_MSG', DEVICE_MESSAGE_TYPES)}

/* Servidor → Device */
${defines('ROBO_MSG', SERVER_MESSAGE_TYPES)}

${cEnum('ROBO_STATE', 'robo_state_t', DEVICE_STATES)}
${cEnum('ROBO_BTN', 'robo_btn_t', BUTTON_IDS)}
${cEnum('ROBO_BTN_EV', 'robo_btn_ev_t', BUTTON_EVENTS)}
${cEnum('ROBO_DISPLAY', 'robo_display_t', DISPLAY_MODES)}
${cEnum('ROBO_FACE', 'robo_face_t', FACES)}
${cEnum('ROBO_OTA', 'robo_ota_phase_t', OTA_PHASES)}`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, header);
console.log(`protocol.h gerado em ${out}`);
