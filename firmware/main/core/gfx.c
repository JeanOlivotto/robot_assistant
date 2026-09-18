#include "gfx.h"

#include <stdlib.h>
#include <string.h>
#include "esp_heap_caps.h"

extern const uint8_t font8x8_basic[95][8];

static uint16_t *s_fb;
static int s_clip_x0, s_clip_y0, s_clip_x1 = GFX_W, s_clip_y1 = GFX_H; /* [x0,x1) × [y0,y1) */
static uint8_t s_bright = 255;

/* ── Cor ─────────────────────────────────────────────────────────────── */

static inline uint16_t swap16(uint16_t v)
{
    return (uint16_t)((v >> 8) | (v << 8));
}

static uint16_t scale_color(uint16_t c, uint8_t k)
{
    if (k == 255) return c;
    const uint16_t v = swap16(c);
    const uint32_t r = ((v >> 11) & 0x1F) * k / 255;
    const uint32_t g = ((v >> 5) & 0x3F) * k / 255;
    const uint32_t b = (v & 0x1F) * k / 255;
    return swap16((uint16_t)((r << 11) | (g << 5) | b));
}

uint16_t gfx_mix(uint16_t a, uint16_t b, uint8_t t)
{
    const uint16_t va = swap16(a), vb = swap16(b);
    const int ra = (va >> 11) & 0x1F, ga = (va >> 5) & 0x3F, ba = va & 0x1F;
    const int rb = (vb >> 11) & 0x1F, gb = (vb >> 5) & 0x3F, bb = vb & 0x1F;
    const int r = ra + (rb - ra) * t / 255;
    const int g = ga + (gb - ga) * t / 255;
    const int bl = ba + (bb - ba) * t / 255;
    return swap16((uint16_t)((r << 11) | (g << 5) | bl));
}

void gfx_set_brightness(uint8_t level)
{
    s_bright = level;
}

/* ── Base ────────────────────────────────────────────────────────────── */

void gfx_init(void)
{
    s_fb = heap_caps_calloc(GFX_W * GFX_H, sizeof(uint16_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!s_fb) abort();
}

uint16_t *gfx_fb(void)
{
    return s_fb;
}

void gfx_set_clip(int x, int y, int w, int h)
{
    s_clip_x0 = x < 0 ? 0 : x;
    s_clip_y0 = y < 0 ? 0 : y;
    s_clip_x1 = x + w > GFX_W ? GFX_W : x + w;
    s_clip_y1 = y + h > GFX_H ? GFX_H : y + h;
}

void gfx_reset_clip(void)
{
    gfx_set_clip(0, 0, GFX_W, GFX_H);
}

void gfx_clear(uint16_t c)
{
    c = scale_color(c, s_bright);
    for (int i = 0; i < GFX_W * GFX_H; i++) s_fb[i] = c;
}

void gfx_hspan(int y, int x0, int x1, uint16_t c)
{
    if (y < s_clip_y0 || y >= s_clip_y1) return;
    if (x0 > x1) {
        const int t = x0;
        x0 = x1;
        x1 = t;
    }
    if (x0 < s_clip_x0) x0 = s_clip_x0;
    if (x1 >= s_clip_x1) x1 = s_clip_x1 - 1;
    if (x0 > x1) return;
    c = scale_color(c, s_bright);
    uint16_t *p = s_fb + y * GFX_W + x0;
    for (int n = x1 - x0 + 1; n > 0; n--) *p++ = c;
}

void gfx_fill_rect(int x, int y, int w, int h, uint16_t c)
{
    for (int i = 0; i < h; i++) gfx_hspan(y + i, x, x + w - 1, c);
}

/* ── Formas ──────────────────────────────────────────────────────────── */

static int isqrt(int v)
{
    if (v <= 0) return 0;
    int x = 1 << ((32 - __builtin_clz((unsigned)v) + 1) / 2); /* chute inicial ≥ √v */
    for (;;) {
        const int y = (x + v / x) / 2;
        if (y >= x) return x;
        x = y;
    }
}

/* Meia-largura da elipse na linha dy, amostrando no centro do pixel (coordenadas dobradas). */
static int ellipse_hw(int rx, int ry, int dy)
{
    const int Rx = 2 * rx + 1, Ry = 2 * ry + 1, Dy = 2 * dy;
    const int v = Ry * Ry - Dy * Dy;
    if (v < 0) return -1;
    return (Rx * isqrt(v) / Ry) / 2;
}

void gfx_fill_round_rect(int x, int y, int w, int h, int r, uint16_t c)
{
    if (w <= 0 || h <= 0) return;
    const int rmax = (w < h ? w : h) / 2;
    if (r > rmax) r = rmax;
    if (r <= 0) {
        gfx_fill_rect(x, y, w, h, c);
        return;
    }
    const int r2 = 2 * r;
    for (int i = 0; i < h; i++) {
        int d = 0; /* linhas até o trecho reto */
        if (i < r) d = r - i;
        else if (i >= h - r) d = i - (h - 1 - r);
        int inset = 0;
        if (d > 0) {
            const int dd = 2 * d - 1;
            inset = (r2 - isqrt(r2 * r2 - dd * dd)) / 2;
        }
        gfx_hspan(y + i, x + inset, x + w - 1 - inset, c);
    }
}

void gfx_fill_ellipse(int cx, int cy, int rx, int ry, uint16_t c)
{
    if (rx <= 0 || ry <= 0) {
        if (rx >= 0 && ry >= 0) gfx_hspan(cy, cx - rx, cx + rx, c);
        return;
    }
    for (int dy = -ry; dy <= ry; dy++) {
        const int hw = ellipse_hw(rx, ry, dy);
        gfx_hspan(cy + dy, cx - hw, cx + hw, c);
    }
}

void gfx_fill_circle(int cx, int cy, int r, uint16_t c)
{
    gfx_fill_ellipse(cx, cy, r, r, c);
}

void gfx_fill_triangle(int x0, int y0, int x1, int y1, int x2, int y2, uint16_t c)
{
#define SWAP_PT(a, b)            \
    do {                         \
        int t = x##a;            \
        x##a = x##b;             \
        x##b = t;                \
        t = y##a;                \
        y##a = y##b;             \
        y##b = t;                \
    } while (0)
    if (y0 > y1) SWAP_PT(0, 1);
    if (y1 > y2) SWAP_PT(1, 2);
    if (y0 > y1) SWAP_PT(0, 1);
#undef SWAP_PT

    if (y0 == y2) {
        int lo = x0, hi = x0;
        if (x1 < lo) lo = x1;
        if (x2 < lo) lo = x2;
        if (x1 > hi) hi = x1;
        if (x2 > hi) hi = x2;
        gfx_hspan(y0, lo, hi, c);
        return;
    }
    for (int y = y0; y <= y2; y++) {
        const int xa = x0 + (x2 - x0) * (y - y0) / (y2 - y0);
        int xb;
        if (y < y1) xb = x0 + (x1 - x0) * (y - y0) / (y1 - y0);
        else xb = (y2 == y1) ? x1 : x1 + (x2 - x1) * (y - y1) / (y2 - y1);
        gfx_hspan(y, xa, xb, c);
    }
}

void gfx_arc_band(int cx, int cy, int rx, int ry, int thick, bool lower, uint16_t c)
{
    if (rx <= 0 || ry <= 0 || thick <= 0) return;
    const int irx = rx - thick, iry = ry - thick;
    for (int k = 0; k <= ry; k++) {
        const int dy = lower ? k : -k;
        const int ho = ellipse_hw(rx, ry, dy);
        if (ho < 0) continue;
        const int hi = (irx > 0 && iry > 0 && k <= iry) ? ellipse_hw(irx, iry, dy) : -1;
        if (hi < 0) {
            gfx_hspan(cy + dy, cx - ho, cx + ho, c);
        } else {
            gfx_hspan(cy + dy, cx - ho, cx - hi - 1, c);
            gfx_hspan(cy + dy, cx + hi + 1, cx + ho, c);
        }
    }
    /* pontas arredondadas */
    const int cap = thick / 2;
    gfx_fill_circle(cx - rx + cap, cy, cap, c);
    gfx_fill_circle(cx + rx - cap, cy, cap, c);
}

void gfx_thick_line(int x0, int y0, int x1, int y1, int thick, uint16_t c)
{
    const int r = thick / 2;
    const int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    for (;;) {
        gfx_fill_circle(x0, y0, r, c);
        if (x0 == x1 && y0 == y1) break;
        const int e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x0 += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y0 += sy;
        }
    }
}

void gfx_heart(int cx, int cy, int size, uint16_t c)
{
    int r = size / 4;
    if (r < 1) r = 1;
    const int ly = cy - r / 2;
    gfx_fill_circle(cx - r, ly, r, c);
    gfx_fill_circle(cx + r, ly, r, c);
    gfx_fill_triangle(cx - 2 * r, ly, cx + 2 * r, ly, cx, cy + size / 2, c);
}

/* ── Texto ───────────────────────────────────────────────────────────── */

enum { ACC_NONE, ACC_GRAVE, ACC_ACUTE, ACC_CIRC, ACC_TILDE, ACC_DIAER, ACC_CEDIL };

typedef struct {
    uint8_t w;
    uint8_t rows[2]; /* bit 0 = pixel mais à esquerda */
} accent_t;

static const accent_t s_accents[] = {
    [ACC_GRAVE] = {3, {0x01, 0x02}},
    [ACC_ACUTE] = {3, {0x04, 0x02}},
    [ACC_CIRC] = {3, {0x02, 0x05}},
    [ACC_TILDE] = {5, {0x16, 0x09}},
    [ACC_DIAER] = {3, {0x05, 0x00}},
    [ACC_CEDIL] = {2, {0x02, 0x01}},
};

/* U+00C0..U+00FF → letra base + acento (base 0 = sem glifo, vira '?'). */
static const struct {
    char base;
    uint8_t acc;
} s_latin1[64] = {
    {'A', ACC_GRAVE}, {'A', ACC_ACUTE}, {'A', ACC_CIRC}, {'A', ACC_TILDE},
    {'A', ACC_DIAER}, {'A', ACC_NONE}, {0, 0}, {'C', ACC_CEDIL},
    {'E', ACC_GRAVE}, {'E', ACC_ACUTE}, {'E', ACC_CIRC}, {'E', ACC_DIAER},
    {'I', ACC_GRAVE}, {'I', ACC_ACUTE}, {'I', ACC_CIRC}, {'I', ACC_DIAER},
    {'D', ACC_NONE}, {'N', ACC_TILDE}, {'O', ACC_GRAVE}, {'O', ACC_ACUTE},
    {'O', ACC_CIRC}, {'O', ACC_TILDE}, {'O', ACC_DIAER}, {'x', ACC_NONE},
    {'O', ACC_NONE}, {'U', ACC_GRAVE}, {'U', ACC_ACUTE}, {'U', ACC_CIRC},
    {'U', ACC_DIAER}, {'Y', ACC_ACUTE}, {0, 0}, {0, 0},
    {'a', ACC_GRAVE}, {'a', ACC_ACUTE}, {'a', ACC_CIRC}, {'a', ACC_TILDE},
    {'a', ACC_DIAER}, {'a', ACC_NONE}, {0, 0}, {'c', ACC_CEDIL},
    {'e', ACC_GRAVE}, {'e', ACC_ACUTE}, {'e', ACC_CIRC}, {'e', ACC_DIAER},
    {'i', ACC_GRAVE}, {'i', ACC_ACUTE}, {'i', ACC_CIRC}, {'i', ACC_DIAER},
    {'d', ACC_NONE}, {'n', ACC_TILDE}, {'o', ACC_GRAVE}, {'o', ACC_ACUTE},
    {'o', ACC_CIRC}, {'o', ACC_TILDE}, {'o', ACC_DIAER}, {'/', ACC_NONE},
    {'o', ACC_NONE}, {'u', ACC_GRAVE}, {'u', ACC_ACUTE}, {'u', ACC_CIRC},
    {'u', ACC_DIAER}, {'y', ACC_ACUTE}, {0, 0}, {'y', ACC_DIAER},
};

static const uint8_t s_dotless_i[8] = {0x00, 0x00, 0x0E, 0x0C, 0x0C, 0x0C, 0x1E, 0x00};

typedef struct {
    const uint8_t *rows;
    char base;
    uint8_t acc;
} glyph_t;

static uint32_t utf8_next(const char **ps)
{
    const uint8_t *s = (const uint8_t *)*ps;
    uint32_t cp = '?';
    int n = 1;
    if (s[0] < 0x80) {
        cp = s[0];
    } else if ((s[0] & 0xE0) == 0xC0 && (s[1] & 0xC0) == 0x80) {
        cp = ((s[0] & 0x1Fu) << 6) | (s[1] & 0x3Fu);
        n = 2;
    } else if ((s[0] & 0xF0) == 0xE0 && (s[1] & 0xC0) == 0x80 && (s[2] & 0xC0) == 0x80) {
        cp = ((s[0] & 0x0Fu) << 12) | ((s[1] & 0x3Fu) << 6) | (s[2] & 0x3Fu);
        n = 3;
    } else if ((s[0] & 0xF8) == 0xF0 && (s[1] & 0xC0) == 0x80 && (s[2] & 0xC0) == 0x80 &&
               (s[3] & 0xC0) == 0x80) {
        cp = 0x10000; /* fora do plano básico: só precisamos saber que não temos glifo */
        n = 4;
    }
    *ps += n;
    return cp;
}

static glyph_t resolve(uint32_t cp)
{
    glyph_t g = {.acc = ACC_NONE};
    if (cp >= 0x20 && cp <= 0x7E) g.base = (char)cp;
    else if (cp >= 0xC0 && cp <= 0xFF && s_latin1[cp - 0xC0].base) {
        g.base = s_latin1[cp - 0xC0].base;
        g.acc = s_latin1[cp - 0xC0].acc;
    } else if (cp == 0xA0) g.base = ' ';
    else if (cp == 0xAA) g.base = 'a';
    else if (cp == 0xBA || cp == 0xB0) g.base = 'o';
    else if (cp == 0xB7) g.base = '.';
    else g.base = '?';

    g.rows = (g.base == 'i' && g.acc != ACC_NONE) ? s_dotless_i : font8x8_basic[g.base - 0x20];
    return g;
}

/* Métrica proporcional: corta colunas vazias. Dígitos têm largura fixa para o relógio não tremer. */
static void glyph_span(const glyph_t *g, int *left, int *width)
{
    if (g->base >= '0' && g->base <= '9') {
        *left = 0;
        *width = 7;
        return;
    }
    uint8_t m = 0;
    for (int i = 0; i < 8; i++) m |= g->rows[i];
    if (!m) {
        *left = 0;
        *width = 3;
        return;
    }
    *left = __builtin_ctz(m);
    *width = 31 - __builtin_clz(m) - *left + 1;
}

static int draw_glyph(int x, int y, const glyph_t *g, uint16_t c, int scale, bool draw)
{
    int left, w;
    glyph_span(g, &left, &w);
    if (draw) {
        for (int row = 0; row < 8; row++) {
            uint8_t bits = g->rows[row] >> left;
            for (int col = 0; bits; col++, bits >>= 1) {
                if (bits & 1) gfx_fill_rect(x + col * scale, y + row * scale, scale, scale, c);
            }
        }
        if (g->acc != ACC_NONE) {
            const accent_t *a = &s_accents[g->acc];
            const int ax = x + ((w - a->w) * scale) / 2;
            const bool upper = g->base >= 'A' && g->base <= 'Z';
            const int ay = g->acc == ACC_CEDIL ? y + 7 * scale : upper ? y - 2 * scale : y - scale;
            for (int row = 0; row < 2; row++) {
                for (int col = 0; col < a->w; col++) {
                    if (a->rows[row] & (1 << col)) {
                        gfx_fill_rect(ax + col * scale, ay + row * scale, scale, scale, c);
                    }
                }
            }
        }
    }
    return (w + 1) * scale;
}

static int run(int x, int y, const char *s, const char *end, uint16_t c, int scale, bool draw)
{
    const int x0 = x;
    while (*s && (!end || s < end)) {
        const glyph_t g = resolve(utf8_next(&s));
        x += draw_glyph(x, y, &g, c, scale, draw);
    }
    return x - x0;
}

int gfx_text(int x, int y, const char *s, uint16_t c, int scale)
{
    return run(x, y, s, NULL, c, scale, true);
}

int gfx_text_width(const char *s, int scale)
{
    const int w = run(0, 0, s, NULL, 0, scale, false);
    return w > 0 ? w - scale : 0; /* sem o espaço depois do último glifo */
}

void gfx_text_center(int cx, int y, const char *s, uint16_t c, int scale)
{
    gfx_text(cx - gfx_text_width(s, scale) / 2, y, s, c, scale);
}

void gfx_text_fit(int x, int y, int max_w, const char *s, uint16_t c, int scale)
{
    if (gfx_text_width(s, scale) <= max_w) {
        gfx_text(x, y, s, c, scale);
        return;
    }
    const int dots = gfx_text_width("..", scale) + scale;
    int cx = x;
    while (*s) {
        const char *next = s;
        const glyph_t g = resolve(utf8_next(&next));
        const int adv = draw_glyph(0, 0, &g, c, scale, false);
        if (cx + adv - x + dots > max_w) break;
        draw_glyph(cx, y, &g, c, scale, true);
        cx += adv;
        s = next;
    }
    gfx_text(cx, y, "..", c, scale);
}

static int width_n(const char *s, const char *end, int scale)
{
    const int w = run(0, 0, s, end, 0, scale, false);
    return w > 0 ? w - scale : 0;
}

int gfx_text_wrap(int x, int y, int w, const char *s, uint16_t c, int scale, int max_lines)
{
    int lines = 0;
    while (*s && lines < max_lines) {
        while (*s == ' ') s++;
        if (!*s) break;

        /* maior trecho terminando em fim de palavra que cabe na linha */
        const char *fit = NULL, *q = s;
        for (;;) {
            const char *we = q;
            while (*we && *we != ' ') we++;
            if (width_n(s, we, scale) > w) break;
            fit = we;
            if (!*we) break;
            q = we + 1;
        }

        if (lines == max_lines - 1 && !(fit && *fit == '\0')) {
            gfx_text_fit(x, y, w, s, c, scale);
            return lines + 1;
        }

        const char *cut = fit;
        if (!cut) { /* palavra maior que a linha: quebra no caractere */
            const char *p = s;
            cut = s;
            while (*p) {
                const char *nx = p;
                utf8_next(&nx);
                if (width_n(s, nx, scale) > w) break;
                cut = p = nx;
            }
            if (cut == s) utf8_next(&cut); /* garante progresso */
        }
        run(x, y, s, cut, c, scale, true);
        s = cut;
        y += GFX_LINE_H * scale;
        lines++;
    }
    return lines;
}
