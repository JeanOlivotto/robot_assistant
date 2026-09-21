#include "face.h"

#include <stdbool.h>
#include "esp_random.h"
#include "gfx.h"
#include "protocol.h"

_Static_assert((int)FACE__COUNT == (int)ROBO_FACE__COUNT, "face_expr_t fora de sincronia com FACES do protocolo");
_Static_assert((int)FACE_THINKING == (int)ROBO_FACE_THINKING && (int)FACE_BORED == (int)ROBO_FACE_BORED &&
                   (int)FACE_ERROR == (int)ROBO_FACE_ERROR && (int)FACE_NEUTRAL == (int)ROBO_FACE_NEUTRAL,
               "ordem de face_expr_t difere de robo_face_t");

#define EYE_GAP  48 /* distância entre os centros dos olhos */
#define MOUTH_DY 27 /* boca abaixo da linha dos olhos */

#define C_BG    GFX_RGB(0, 0, 0)
#define C_EYE   GFX_RGB(90, 230, 240)
#define C_LOVE  GFX_RGB(255, 90, 140)
#define C_ERR   GFX_RGB(255, 80, 80)
#define C_BLUSH GFX_RGB(255, 120, 170)
#define C_SWEAT GFX_RGB(110, 190, 255)
#define C_ANGRY GFX_RGB(255, 140, 60)  /* bravo: laranja quente */
#define C_HACK  GFX_RGB(255, 40, 40)   /* modo hacker: tudo vermelho */
#define C_EVIL  GFX_RGB(190, 90, 255)  /* malvado: roxo (no modo hacker vira vermelho) */

typedef enum { EYES_OPEN, EYES_CLOSED, EYES_X, EYES_HEART } eyes_t;
typedef enum { MOUTH_NONE, MOUTH_SMILE, MOUTH_GRIN, MOUTH_FROWN, MOUTH_O, MOUTH_FLAT } mouth_t;

/* Parâmetros numéricos — estes são interpolados entre expressões. */
enum { P_EYE_W, P_EYE_H, P_EYE_R, P_LID_TOP, P_LID_BOT, P_SLANT, P_EYE_DY, P_MOUTH_W, P_MOUTH_H, P__COUNT };

typedef struct {
    const char *name;
    eyes_t eyes;
    mouth_t mouth;
    int8_t p[P__COUNT];
    uint16_t color;
    bool blinks, blush, sweat, zzz, hearts, dots;
    bool fixed_gaze; /* olhar parado em (gaze_x, gaze_y) em vez de vaguear */
    int8_t gaze_x, gaze_y;
} face_def_t;

/* Os mesmos números estão em apps/web/src/components/RobotFace.tsx — manter em sincronia.
                                       eye_w eye_h eye_r lid_top lid_bot slant eye_dy mouth_w mouth_h */
static const face_def_t s_defs[FACE__COUNT] = {
    [FACE_NEUTRAL]   = {"neutro",     EYES_OPEN,   MOUTH_SMILE, {24, 30, 8, 0, 0, 0, 0, 12, 5},   C_EYE,  .blinks = true},
    [FACE_HAPPY]     = {"feliz",      EYES_OPEN,   MOUTH_GRIN,  {24, 30, 8, 0, 13, 0, 0, 16, 8},  C_EYE,  .blinks = true, .blush = true},
    [FACE_LOVE]      = {"amor",       EYES_HEART,  MOUTH_GRIN,  {26, 26, 8, 0, 0, 0, 0, 16, 8},   C_LOVE, .blush = true, .hearts = true},
    [FACE_SLEEPY]    = {"sono",       EYES_OPEN,   MOUTH_FLAT,  {24, 30, 8, 16, 0, 0, 2, 8, 3},   C_EYE,  .blinks = true},
    [FACE_SLEEPING]  = {"dormindo",   EYES_CLOSED, MOUTH_O,     {24, 12, 6, 0, 0, 0, 4, 6, 6},    C_EYE,  .zzz = true},
    [FACE_WORRIED]   = {"preocupado", EYES_OPEN,   MOUTH_FROWN, {22, 28, 8, 0, 0, 10, 0, 12, 5},  C_EYE,  .blinks = true, .sweat = true},
    [FACE_SURPRISED] = {"surpreso",   EYES_OPEN,   MOUTH_O,     {26, 34, 13, 0, 0, 0, -2, 9, 10}, C_EYE,  .blinks = true},
    [FACE_SAD]       = {"triste",     EYES_OPEN,   MOUTH_FROWN, {22, 24, 8, 3, 0, 8, 4, 14, 6},   C_EYE,  .blinks = true},
    [FACE_ERROR]     = {"erro",       EYES_X,      MOUTH_FLAT,  {20, 20, 0, 0, 0, 0, 0, 14, 3},   C_ERR},
    [FACE_THINKING]  = {"pensando",   EYES_OPEN,   MOUTH_FLAT,  {22, 24, 8, 6, 0, 0, -2, 8, 3},   C_EYE,  .blinks = true, .dots = true,
                        .fixed_gaze = true, .gaze_x = -7, .gaze_y = -5},
    [FACE_BORED]     = {"entediado",  EYES_OPEN,   MOUTH_FLAT,  {24, 30, 8, 14, 0, 0, 3, 10, 2},  C_EYE,  .blinks = true,
                        .fixed_gaze = true, .gaze_x = 8, .gaze_y = 2},
    [FACE_JAMMING]   = {"curtindo",   EYES_OPEN,   MOUTH_GRIN,  {24, 28, 8, 0, 17, 0, 0, 16, 8},  C_EYE,  .blinks = true, .blush = true},
    /* bravo: slant negativo corta o canto INTERNO do olho — é a sobrancelha fechada. */
    [FACE_ANGRY]     = {"bravo",      EYES_OPEN,   MOUTH_FROWN, {24, 22, 6, 0, 0, -13, 1, 14, 5}, C_ANGRY, .blinks = true},
    /* malvado: mesma sobrancelha fechada do bravo, mas sorrindo — e olho mais fechado por cima. */
    [FACE_EVIL]      = {"malvado",    EYES_OPEN,   MOUTH_GRIN,  {24, 20, 5, 6, 0, -14, 1, 15, 6}, C_EVIL,  .blinks = true},
};

/* Modo hacker: a cor da expressão dá lugar ao vermelho, e só ela muda — o desenho é o mesmo. */
static bool s_hacker;

void face_set_hacker(bool on)
{
    s_hacker = on;
}

bool face_hacker(void)
{
    return s_hacker;
}

/* Cor do traço: a da expressão, ou o vermelho do modo hacker. */
static uint16_t ink(const face_def_t *d)
{
    return s_hacker ? C_HACK : d->color;
}

#define BLINK_CLOSE_MS 70
#define BLINK_HOLD_MS  30
#define BLINK_OPEN_MS  90

static face_expr_t s_expr = FACE_NEUTRAL;
static face_expr_t s_pending = FACE_NEUTRAL;
static bool s_has_pending;

static int32_t s_cur[P__COUNT]; /* ×16 para interpolar sem float (o C3 não tem FPU) */

static bool s_blinking;
static uint32_t s_blink_start, s_next_blink;
static int s_open = 256; /* abertura do olho: 256 aberto → 0 fechado */

static int32_t s_gx, s_gy, s_tgx, s_tgy; /* olhar ×16 */
static uint32_t s_next_gaze;
static int s_look_x, s_look_y;
static uint32_t s_look_until;

void face_look_at(int dx, int dy, uint32_t until_ms)
{
    s_look_x = dx < -9 ? -9 : dx > 9 ? 9 : dx;
    s_look_y = dy < -7 ? -7 : dy > 7 ? 7 : dy;
    s_look_until = until_ms;
}

static uint32_t rnd(uint32_t lo, uint32_t hi)
{
    return lo + esp_random() % (hi - lo + 1);
}

static int P(int i)
{
    return (int)(s_cur[i] / 16);
}

void face_init(void)
{
    for (int i = 0; i < P__COUNT; i++) s_cur[i] = s_defs[FACE_NEUTRAL].p[i] * 16;
    s_next_blink = rnd(1500, 3000);
    s_next_gaze = rnd(800, 2000);
}

void face_set(face_expr_t e)
{
    if (e >= FACE__COUNT) return;
    if (s_has_pending ? e == s_pending : e == s_expr) return;
    s_pending = e;
    s_has_pending = true;
}

face_expr_t face_get(void)
{
    return s_has_pending ? s_pending : s_expr;
}

const char *face_name(face_expr_t e)
{
    return e < FACE__COUNT ? s_defs[e].name : "?";
}

static void update(uint32_t now)
{
    const face_def_t *d = &s_defs[s_expr];

    /* Troca de expressão: com olho aberto, espera a piscada fechar para trocar. */
    if (s_has_pending) {
        if (d->eyes != EYES_OPEN) {
            s_expr = s_pending;
            s_has_pending = false;
        } else if (!s_blinking) {
            s_blinking = true;
            s_blink_start = now;
        }
    }

    /* Piscada */
    if (!s_blinking && s_defs[s_expr].blinks && now >= s_next_blink) {
        s_blinking = true;
        s_blink_start = now;
    }
    if (s_blinking) {
        const uint32_t t = now - s_blink_start;
        /* Troca a partir do olho fechado, não só dentro da janela de 30 ms: a 5 fps (repouso)
           o quadro pula a janela inteira e a expressão nova nunca entrava. */
        if (t >= BLINK_CLOSE_MS && s_has_pending) {
            s_expr = s_pending;
            s_has_pending = false;
        }
        if (t < BLINK_CLOSE_MS) {
            s_open = 256 - (int)(t * 256 / BLINK_CLOSE_MS);
        } else if (t < BLINK_CLOSE_MS + BLINK_HOLD_MS) {
            s_open = 0;
        } else if (t < BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS) {
            s_open = (int)((t - BLINK_CLOSE_MS - BLINK_HOLD_MS) * 256 / BLINK_OPEN_MS);
        } else {
            s_open = 256;
            s_blinking = false;
            s_next_blink = now + (rnd(0, 99) < 15 ? 180 : rnd(2500, 6000)); /* às vezes pisca duas vezes */
        }
    } else {
        s_open = 256;
    }
    d = &s_defs[s_expr];

    /* Parâmetros deslizam até o alvo da expressão atual */
    for (int i = 0; i < P__COUNT; i++) {
        const int32_t target = d->p[i] * 16;
        s_cur[i] += (target - s_cur[i]) / 4;
    }

    /* Olhar: para onde mandaram (bolinha), parado onde a expressão manda, ou vagueando */
    if ((int32_t)(s_look_until - now) > 0) {
        s_tgx = s_look_x * 16;
        s_tgy = s_look_y * 16;
    } else if (d->fixed_gaze) {
        s_tgx = d->gaze_x * 16;
        s_tgy = d->gaze_y * 16;
    } else if (d->eyes == EYES_OPEN && s_expr != FACE_SURPRISED) {
        if (now >= s_next_gaze) {
            if (rnd(0, 99) < 35) {
                s_tgx = s_tgy = 0;
            } else {
                s_tgx = ((int32_t)rnd(0, 14) - 7) * 16;
                s_tgy = ((int32_t)rnd(0, 8) - 4) * 16;
            }
            s_next_gaze = now + rnd(1200, 4000);
        }
    } else {
        s_tgx = s_tgy = 0;
    }
    s_gx += (s_tgx - s_gx) / 3;
    s_gy += (s_tgy - s_gy) / 3;
}

static void draw_open_eye(int ex, int ey, int side, uint16_t color)
{
    const int w = P(P_EYE_W), h = P(P_EYE_H) > 1 ? P(P_EYE_H) : 1;
    int hh = h * s_open / 256;
    if (hh < 3) hh = 3;
    const int top = ey - hh / 2;
    gfx_fill_round_rect(ex - w / 2, top, w, hh, P(P_EYE_R), color);

    /* pálpebra de cima (sono) */
    const int lid = P(P_LID_TOP) * hh / h;
    if (lid > 0) gfx_fill_rect(ex - w / 2 - 1, top - 1, w + 2, lid + 1, C_BG);

    /* "bochecha" subindo por baixo — vira o olho sorridente ^ */
    const int lb = P(P_LID_BOT) * hh / h;
    if (lb > 0) {
        const int rx = w / 2 + 2, ry = w / 2;
        gfx_fill_ellipse(ex, top + hh - lb + ry, rx, ry, C_BG);
    }

    /* canto externo caído (triste/preocupado) ou interno (bravo) */
    const int sl = P(P_SLANT) * hh / h;
    if (sl != 0) {
        const int outer = ex + side * (w / 2 + 1), inner = ex - side * (w / 2 + 1), t = top - 1;
        if (sl > 0) gfx_fill_triangle(outer, t, outer, t + sl + 1, inner, t, C_BG);
        else gfx_fill_triangle(inner, t, inner, t - sl + 1, outer, t, C_BG);
    }
}

static void draw_mouth(int mx, int my, const face_def_t *d)
{
    const int w = P(P_MOUTH_W), h = P(P_MOUTH_H);
    switch (d->mouth) {
    case MOUTH_SMILE:
        gfx_arc_band(mx, my - h / 2, w / 2, h, 3, true, ink(d));
        break;
    case MOUTH_GRIN: /* meia elipse cheia */
        gfx_set_clip(0, my - h / 2, GFX_W, GFX_H);
        gfx_fill_ellipse(mx, my - h / 2, w / 2, h, ink(d));
        gfx_reset_clip();
        break;
    case MOUTH_FROWN:
        gfx_arc_band(mx, my + h / 2, w / 2, h, 3, false, ink(d));
        break;
    case MOUTH_O:
        gfx_fill_ellipse(mx, my, w / 2, h / 2, ink(d));
        if (w / 2 > 2 && h / 2 > 2) gfx_fill_ellipse(mx, my, w / 2 - 2, h / 2 - 2, C_BG);
        break;
    case MOUTH_FLAT:
        gfx_fill_round_rect(mx - w / 2, my - h / 2, w, h, h / 2, ink(d));
        break;
    case MOUTH_NONE:
        break;
    }
}

static void draw_extras(int cx, int cy, uint32_t now, const face_def_t *d)
{
    if (d->zzz) {
        for (int i = 0; i < 3; i++) {
            const uint32_t ph = (now + i * 900) % 2700;
            const uint16_t c = gfx_mix(ink(d), C_BG, (uint8_t)(ph * 255 / 2700));
            gfx_text(cx + 34 + ph / 150, cy - 14 - ph / 112, "z", c, ph > 1400 ? 2 : 1);
        }
    }
    if (d->hearts) {
        for (int i = 0; i < 3; i++) {
            const uint32_t ph = (now + i * 700) % 2100;
            const int x = cx + (i % 2 ? 54 : -54) + ((ph / 250) % 2 ? 1 : -1);
            const uint16_t c = gfx_mix(C_LOVE, C_BG, (uint8_t)(ph * 255 / 2100));
            gfx_heart(x, cy + 24 - (int)(ph / 50), 9, c);
        }
    }
    if (d->dots) { /* três pontinhos pulsando, em sequência */
        for (int i = 0; i < 3; i++) {
            const bool up = ((now / 220) % 4) == (uint32_t)i;
            gfx_fill_circle(cx + 28 + i * 8, cy - 36 - (up ? 2 : 0), up ? 3 : 2, ink(d));
        }
    }
    if (d->sweat) {
        const int x = cx + EYE_GAP / 2 + 17, y = cy - 20 + (int)((now % 1600) / 200);
        gfx_fill_circle(x, y + 3, 3, C_SWEAT);
        gfx_fill_triangle(x - 3, y + 2, x + 3, y + 2, x, y - 4, C_SWEAT);
    }
}

/* Onda triangular de -amp a +amp — a "respiração" enquanto dorme. */
static int breathe(uint32_t now, uint32_t period, int amp)
{
    const uint32_t ph = now % period;
    const uint32_t half = period / 2;
    const int v = (int)(ph < half ? ph : period - ph); /* 0..half */
    return (v * 2 * amp + (int)half / 2) / (int)half - amp;
}

void face_draw(int cx, int cy, uint32_t now_ms)
{
    update(now_ms);
    const face_def_t *d = &s_defs[s_expr];
    const int gx = (int)(s_gx / 16), gy = (int)(s_gy / 16);
    const int bob = d->zzz ? breathe(now_ms, 3200, 2) : 0;
    const int ey = cy + P(P_EYE_DY) + gy + bob;

    for (int side = -1; side <= 1; side += 2) {
        const int ex = cx + side * EYE_GAP / 2 + gx;
        switch (d->eyes) {
        case EYES_OPEN:
            draw_open_eye(ex, ey, side, ink(d));
            break;
        case EYES_CLOSED:
            gfx_arc_band(ex, ey - 3, P(P_EYE_W) / 2, 7, 3, true, ink(d));
            break;
        case EYES_X: {
            const int s = P(P_EYE_W) / 2 - 2;
            gfx_thick_line(ex - s, ey - s, ex + s, ey + s, 4, ink(d));
            gfx_thick_line(ex - s, ey + s, ex + s, ey - s, 4, ink(d));
            break;
        }
        case EYES_HEART:
            gfx_heart(ex, ey, P(P_EYE_W) + ((now_ms / 300) % 2 ? 2 : 0), ink(d));
            break;
        }
        if (d->blush) gfx_fill_ellipse(ex + side * 4, ey + P(P_EYE_H) / 2 + 6, 6, 3, C_BLUSH);
    }

    draw_mouth(cx + gx / 2, cy + MOUTH_DY + gy / 2 + bob, d);
    draw_extras(cx, cy, now_ms, d);
}
