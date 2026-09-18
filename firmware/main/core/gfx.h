/* Desenho procedural num framebuffer RGB565 de 128×128 (32 KB). Sem sprites, sem LVGL. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define GFX_W 128
#define GFX_H 128

/* RGB565 com os bytes já trocados: o painel recebe o byte alto primeiro pelo SPI. */
#define GFX_RGB(r, g, b) \
    ((uint16_t)((((r) & 0xF8) | ((g) >> 5)) | (((((g) & 0x1C) << 3) | ((b) >> 3)) << 8)))

/* Linha de texto: 2 px de acento + 8 px de glifo + 1 px de respiro (× escala). */
#define GFX_LINE_H 11

void gfx_init(void);
uint16_t *gfx_fb(void);

/* Brilho global aplicado a tudo que for desenhado (255 = normal). A placa não controla o backlight. */
void gfx_set_brightness(uint8_t level);
uint16_t gfx_mix(uint16_t a, uint16_t b, uint8_t t); /* t=0 → a, t=255 → b */

void gfx_set_clip(int x, int y, int w, int h);
void gfx_reset_clip(void);

void gfx_clear(uint16_t c);
void gfx_hspan(int y, int x0, int x1, uint16_t c); /* x0..x1 inclusivo */
void gfx_fill_rect(int x, int y, int w, int h, uint16_t c);
void gfx_fill_round_rect(int x, int y, int w, int h, int r, uint16_t c);
void gfx_fill_ellipse(int cx, int cy, int rx, int ry, uint16_t c);
void gfx_fill_circle(int cx, int cy, int r, uint16_t c);
void gfx_fill_triangle(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t c);
/* Faixa em arco (metade de uma elipse "oca") com pontas arredondadas: sorriso, olho fechado. */
void gfx_arc_band(int cx, int cy, int rx, int ry, int thick, bool lower, uint16_t c);
void gfx_thick_line(int x0, int y0, int x1, int y1, int thick, uint16_t c);
void gfx_heart(int cx, int cy, int size, uint16_t c);

/* Texto UTF-8 (ASCII + acentos do português). y = topo do glifo; acento de maiúscula fica 2 px acima. */
int gfx_text(int x, int y, const char *s, uint16_t c, int scale);
int gfx_text_width(const char *s, int scale);
void gfx_text_center(int cx, int y, const char *s, uint16_t c, int scale);
/* Uma linha só; se não couber em max_w, corta e termina com "..". */
void gfx_text_fit(int x, int y, int max_w, const char *s, uint16_t c, int scale);
/* Quebra por palavra em até max_lines linhas; retorna quantas usou. */
int gfx_text_wrap(int x, int y, int w, const char *s, uint16_t c, int scale, int max_lines);
