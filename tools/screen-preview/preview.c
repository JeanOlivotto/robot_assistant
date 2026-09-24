/*
 * Gera a tela do robô no computador, sem gravar firmware: compila gfx/face/music_view como estão
 * e escreve uma tira de quadros num PPM. Uso: ./preview.sh (gera preview.png).
 */
#include <stdio.h>
#include "face.h"
#include "gfx.h"
#include "icons.h"
#include "music_view.h"

#define FRAMES 4
#define GAP_MS 700

int main(int argc, char **argv)
{
    const char *title = argc > 1 ? argv[1] : "Bohemian Rhapsody - Remastered 2011";
    const char *artist = argc > 2 ? argv[2] : "Queen";
    static uint8_t out[GFX_H][(GFX_W + 4) * FRAMES][3];

    gfx_init();
    face_init();
    face_set(FACE_JAMMING);
    uint32_t now = 0;
    for (; now < 3000; now += 33) { /* deixa a troca de expressão assentar */
        gfx_clear(0);
        music_view_draw(now, "11:47", title, artist);
    }
    for (int f = 0; f < FRAMES; f++) {
        for (uint32_t t = 0; t < GAP_MS; t += 33) {
            gfx_clear(0);
            music_view_draw(now += 33, "11:47", title, artist);
        }
        icon_bluetooth(101, 3, f % 2 == 0); /* quadros pares: iPhone perto; ímpares: ninguém */
        for (int i = 0; i < 4; i++) gfx_fill_rect(113 + i * 3, 12 - i * 3, 2, 3 + i * 3, GFX_RGB(60, 220, 120));
        const uint16_t *fb = gfx_fb();
        for (int y = 0; y < GFX_H; y++)
            for (int x = 0; x < GFX_W; x++) {
                const uint16_t v = fb[y * GFX_W + x];
                const uint16_t c = (uint16_t)(((v & 0xFF) << 8) | (v >> 8)); /* desfaz a troca de bytes do painel */
                uint8_t *p = out[y][f * (GFX_W + 4) + x];
                p[0] = (uint8_t)(((c >> 11) & 0x1F) * 255 / 31);
                p[1] = (uint8_t)(((c >> 5) & 0x3F) * 255 / 63);
                p[2] = (uint8_t)((c & 0x1F) * 255 / 31);
            }
        for (int y = 0; y < GFX_H; y++)
            for (int x = GFX_W; x < GFX_W + 4; x++) out[y][f * (GFX_W + 4) + x][0] = out[y][f * (GFX_W + 4) + x][1] = out[y][f * (GFX_W + 4) + x][2] = 90;
    }
    printf("P6\n%d %d\n255\n", (GFX_W + 4) * FRAMES, GFX_H);
    fwrite(out, sizeof(out), 1, stdout);
    return 0;
}
