/* Contrato estável entre core/ e o chip (seção 2.5 do doc). O core nunca inclui headers de placa. */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

typedef enum { HAL_WAKE_VAD_LOCAL, HAL_WAKE_ONDEVICE_KW, HAL_WAKE_BUTTON } hal_wake_mode_t;

typedef struct {
    const char *chip_name;
    bool has_psram;
    bool has_local_wakeword;   /* C3: false | S3: true */
    bool supports_opus_encode; /* C3: false | S3: true */
    uint8_t i2s_controllers;
    uint16_t lcd_w, lcd_h;
    hal_wake_mode_t wake_mode;
} hal_caps_t;

const hal_caps_t *hal_caps(void);

/* ── Display ──────────────────────────────────────────────────────────
 * Pixels RGB565 já na ordem de bytes do painel (ver GFX_RGB em gfx.h). */
esp_err_t hal_display_init(void);
/* Envia w×h pixels contíguos para a região (x,y). Retorna só depois do DMA:
   o buffer pode ser reescrito logo em seguida. */
void hal_display_blit(const uint16_t *px, int x, int y, int w, int h);
void hal_display_backlight(uint8_t pct);

/* ── Energia ────────────────────────────────────────────────────────── */
typedef struct {
    int mv;   /* tensão da bateria; < 0 = a placa não tem como medir */
    bool usb; /* ligado a um computador pela USB */
} hal_power_t;

hal_power_t hal_power_read(void);

/* ── Botões ─────────────────────────────────────────────────────────── */
typedef enum { HAL_BTN_BOOT, HAL_BTN_KEY1, HAL_BTN_KEY2, HAL_BTN_COUNT } hal_btn_t;

esp_err_t hal_buttons_init(void);
bool hal_button_down(hal_btn_t b);
