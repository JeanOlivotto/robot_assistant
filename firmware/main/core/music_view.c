#include "music_view.h"

#include <math.h>
#include <stdio.h>
#include "face.h"
#include "gfx.h"

#define C_BG    GFX_RGB(0, 0, 0)
#define C_TEXT  GFX_RGB(235, 235, 235)
#define C_DIM   GFX_RGB(120, 130, 150)
#define C_PHONE GFX_RGB(120, 200, 255) /* fones */
#define C_NOTE  GFX_RGB(180, 130, 255) /* nota musical */
#define C_NOTE2 GFX_RGB(255, 140, 200)

#define BEAT_MS  500  /* ~120 BPM: não sabemos o andamento da música, mas este convence */
#define FACE_Y   60   /* abaixo da linha do relógio, com folga para o arco dos fones */
#define NOTES    4
#define NOTE_MS  2600 /* quanto uma nota leva subindo até sumir */

/* Uma nota musical (colcheia) com a cabeça em (x, y). */
static void draw_note(int x, int y, uint16_t color)
{
    gfx_fill_ellipse(x, y, 3, 2, color);
    gfx_fill_rect(x + 2, y - 10, 2, 10, color);
    gfx_fill_triangle(x + 3, y - 10, x + 3, y - 6, x + 8, y - 8, color);
}

/* Texto que rola quando não cabe (marquee). */
static void render_marquee(int y, const char *text, uint16_t color, uint32_t now)
{
    const int w = GFX_W - 8;
    const int tw = gfx_text_width(text, 1);
    if (tw <= w) {
        gfx_text_center(64, y, text, color, 1);
        return;
    }
    const int span = tw + 24;
    const int off = (int)((now / 30) % (uint32_t)span);
    gfx_set_clip(4, y - 1, w, 10);
    gfx_text(4 - off, y, text, color, 1);
    gfx_text(4 - off + span, y, text, color, 1);
    gfx_reset_clip();
}

/*
 * As notas nascem nos fones, alternando os lados, e sobem balançando até sumir no escuro.
 * Cada uma tem uma fase fixa no ciclo: nada de estado, o quadro sai só do relógio.
 */
static void draw_floating_notes(uint32_t now)
{
    for (int i = 0; i < NOTES; i++) {
        const uint32_t t = (now + (uint32_t)i * (NOTE_MS / NOTES)) % NOTE_MS;
        const float p = (float)t / NOTE_MS; /* 0 → 1 enquanto sobe */
        const bool left = (((now + (uint32_t)i * (NOTE_MS / NOTES)) / NOTE_MS) + (uint32_t)i) % 2 == 0;
        /* Sobem pelos cantos, por fora do arco, e somem antes da barra de cima (relógio e ícones). */
        const int x = (left ? 5 : 113) + (int)(sinf(p * 6.28f + i) * 2.5f);
        const int y = 50 - (int)(p * 20.0f); /* a haste (10 px) nunca passa de y=20: o relógio fica intacto */
        const uint8_t fade = p < 0.45f ? 0 : (uint8_t)((p - 0.45f) / 0.55f * 255.0f);
        draw_note(x, y, gfx_mix(i % 2 ? C_NOTE : C_NOTE2, C_BG, fade));
    }
}

void music_view_draw(uint32_t now, const char *hhmm, const char *title, const char *artist)
{
    /* Mesma barra de cima da tela do rosto: relógio à esquerda, ícones (ui.c) à direita. */
    if (hhmm[0]) gfx_text(4, 3, hhmm, C_TEXT, 2);

    /* Cabeça balançando na batida: desce rápido, volta devagar. */
    const uint32_t in_beat = now % BEAT_MS;
    const int bob = in_beat < 120 ? (int)(in_beat * 3 / 120) : 3 - (int)((in_beat - 120) * 3 / (BEAT_MS - 120));
    const int tilt = ((now / BEAT_MS) % 2) ? 1 : -1; /* uma batida para cada lado */
    const int cy = FACE_Y + bob;

    draw_floating_notes(now);

    face_draw(64 + tilt, cy, now);

    /* Fones: arco largo e baixo (não encosta no relógio) e conchas fora dos olhos, pulsando. */
    const int pulse = in_beat < 90 ? 1 : 0;
    gfx_arc_band(64 + tilt, cy + 4, 54, 38, 3, false, C_PHONE);
    gfx_fill_round_rect(4 + tilt - pulse, cy - 6 - pulse, 11 + pulse * 2, 22 + pulse * 2, 5, C_PHONE);
    gfx_fill_round_rect(113 + tilt - pulse, cy - 6 - pulse, 11 + pulse * 2, 22 + pulse * 2, 5, C_PHONE);

    /* Uma linha só, rolando: título e artista em duas linhas ficavam espremidos embaixo da boca. */
    static char line[160];
    if (!title[0]) snprintf(line, sizeof(line), "tocando algo");
    else if (artist[0]) snprintf(line, sizeof(line), "%s - %s", title, artist);
    else snprintf(line, sizeof(line), "%s", title);
    render_marquee(111, line, C_TEXT, now);
}
