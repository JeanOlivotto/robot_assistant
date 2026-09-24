/*
 * Tela do rosto (modo normal) no computador: ANTES × DEPOIS do layout, lado a lado.
 * Replica o que ui.c desenha (barra de status, rosto, rodapé) com as mesmas medidas.
 */
#include <stdio.h>
#include "face.h"
#include "gfx.h"
#include "icons.h"

#define C_TEXT GFX_RGB(235, 235, 235)
#define C_DIM  GFX_RGB(120, 130, 150)
#define C_OK   GFX_RGB(60, 220, 120)

typedef struct {
    int clock_x; /* <0 = centralizado */
    int face_cy;
    int date_y1, date_y2;
    const char *l1, *l2;
} layout_t;

static void wifi(int x, int bottom)
{
    for (int i = 0; i < 4; i++) gfx_fill_rect(x + i * 3, bottom - (3 + i * 3), 2, 3 + i * 3, C_OK);
}

static void draw(const layout_t *L, uint32_t now)
{
    if (L->clock_x < 0) gfx_text_center(64, 3, "11:47", C_TEXT, 2);
    else gfx_text(L->clock_x, 3, "11:47", C_TEXT, 2);
    wifi(113, 15);
    icon_bluetooth(101, 3, true);
    face_draw(64, L->face_cy, now);
    if (L->l1[0]) gfx_text_center(64, L->date_y1, L->l1, L->l2[0] == '@' ? C_TEXT : C_DIM, 1);
    if (L->l2[0] && L->l2[0] != '@') gfx_text_center(64, L->date_y2, L->l2, C_DIM, 1);
    if (L->l2[0] == '@') gfx_text(4, L->date_y2, L->l2 + 1, GFX_RGB(90, 230, 240), 1);
}

int main(void)
{
    static const layout_t layouts[] = {
        {-1, 60, 103, 115, "quinta-feira", "24 de setembro"}, /* hoje */
        {4, 60, 113, 0, "qui, 24 set", ""},                   /* proposta: data */
        {4, 60, 102, 115, "Bom dia! Dormiu bem?", "@te mandei msg!"}, /* proposta: recado */
    };
    enum { N = sizeof(layouts) / sizeof(layouts[0]), FR = 1 };
    static uint8_t out[GFX_H][(GFX_W + 6) * N * FR][3];
    gfx_init();
    face_init();
    int col = 0;
    for (int l = 0; l < N; l++) {
        const face_expr_t exprs[2] = {FACE_NEUTRAL, FACE_HAPPY};
        for (int f = 0; f < FR; f++, col++) {
            face_set(exprs[f]);
            for (uint32_t now = 0; now < 3000; now += 33) {
                gfx_clear(0);
                draw(&layouts[l], now);
            }
            const uint16_t *fb = gfx_fb();
            for (int y = 0; y < GFX_H; y++) {
                for (int x = 0; x < GFX_W + 6; x++) {
                    uint8_t *p = out[y][col * (GFX_W + 6) + x];
                    if (x >= GFX_W) { p[0] = p[1] = p[2] = (l == 0 || f == 0) ? 90 : 90; continue; }
                    const uint16_t v = fb[y * GFX_W + x];
                    const uint16_t c = (uint16_t)(((v & 0xFF) << 8) | (v >> 8));
                    p[0] = (uint8_t)(((c >> 11) & 0x1F) * 255 / 31);
                    p[1] = (uint8_t)(((c >> 5) & 0x3F) * 255 / 63);
                    p[2] = (uint8_t)((c & 0x1F) * 255 / 31);
                }
            }
        }
    }
    printf("P6\n%d %d\n255\n", (GFX_W + 6) * N * FR, GFX_H);
    fwrite(out, sizeof(out), 1, stdout);
    return 0;
}
