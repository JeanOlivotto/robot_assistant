#include "life.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "esp_random.h"
#include "gfx.h"
#include "protocol.h"

#define C_BALL  GFX_RGB(255, 140, 60)
#define C_SHINE GFX_RGB(255, 230, 200)
#define C_SHADE GFX_RGB(40, 44, 56)

/* Bolinha: posição e velocidade em px×256, um passo por quadro (40 ms). */
#define BALL_R   5
#define FLOOR_Y  94
#define CEIL_Y   24
#define GRAVITY  90

static const char *const PH_ANY[] = {
    "bip bop!", "hmm...", "tô de olho!", "lalala~", "pensando na vida...", "bebe água, hein!",
    "já se alongou hoje?", "alguém aí?", "psiu!", "fazendo nada. adoro.", "tô com fome de dados",
    "brincar de bolinha?", "que silêncio...",
};
static const char *const PH_MORNING[] = {"bom dia!", "café primeiro.", "bora trabalhar!"};
static const char *const PH_AFTERNOON[] = {"hora do almoço?", "tarde preguiçosa...", "foco total!"};
static const char *const PH_EVENING[] = {"dia produtivo?", "quase hora de dormir", "já vai embora?"};
static const char *const PH_WAITING[] = {"me responde lá!", "te mandei msg...", "olha o app!", "tô esperando..."};
static const char *const PH_OFFLINE[] = {"cadê a internet?", "sem sinal...", "alguém me conecta?"};
static const char *const PH_PET[] = {"hehe!", "mais carinho!", "obrigado <3", "que delícia!"};
static const char *const PH_BALL[] = {"boing!", "peguei!", "olha isso!", "de novo!"};

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))
#define PICK(a)  ((a)[esp_random() % COUNT(a)])

static struct {
    bool on;
    int32_t x, y, vx, vy;
    uint32_t until;
} s_ball;

static char s_speech[ROBO_SAY_MAX_BYTES + 1];
static uint32_t s_speech_until;
static uint32_t s_next_play, s_next_chatter;

static uint32_t rnd(uint32_t lo, uint32_t hi)
{
    return lo + esp_random() % (hi - lo + 1);
}

void life_init(uint32_t now)
{
    s_next_play = now + 60000;    /* primeira brincadeira logo, para mostrar que está vivo */
    s_next_chatter = now + 20000;
}

/* ── fala ────────────────────────────────────────────────────────────── */

void life_say(const char *text, uint32_t ms, uint32_t now)
{
    strlcpy(s_speech, text, sizeof(s_speech));
    s_speech_until = now + ms;
}

const char *life_speech(uint32_t now)
{
    return s_speech[0] && (int32_t)(s_speech_until - now) > 0 ? s_speech : NULL;
}

void life_pet(uint32_t now)
{
    life_say(PICK(PH_PET), 2500, now);
}

static void chatter(uint32_t now, const life_ctx_t *c)
{
    char buf[ROBO_SAY_MAX_BYTES + 1];
    if (!c->online) {
        life_say(PICK(PH_OFFLINE), 4500, now);
        return;
    }
    if (c->waiting && esp_random() % 2) {
        life_say(PICK(PH_WAITING), 4500, now);
        return;
    }
    if (c->next_title && c->clock_ok && esp_random() % 3 == 0) {
        struct tm tm;
        const time_t t = (time_t)(c->next_start_ms / 1000);
        localtime_r(&t, &tm);
        snprintf(buf, sizeof(buf), "às %02d:%02d: %s", tm.tm_hour, tm.tm_min, c->next_title);
        life_say(buf, 5000, now);
        return;
    }
    if (c->clock_ok && esp_random() % 3 == 0) {
        struct tm tm;
        const time_t t = (time_t)(c->wall_ms / 1000);
        localtime_r(&t, &tm);
        if (tm.tm_hour < 12) life_say(PICK(PH_MORNING), 4000, now);
        else if (tm.tm_hour < 18) life_say(PICK(PH_AFTERNOON), 4000, now);
        else life_say(PICK(PH_EVENING), 4000, now);
        return;
    }
    life_say(PICK(PH_ANY), 4000, now);
}

/* ── bolinha ─────────────────────────────────────────────────────────── */

void life_play_ball(uint32_t now, uint32_t ms)
{
    const bool left = esp_random() % 2;
    s_ball.on = true;
    s_ball.x = (left ? 12 : GFX_W - 12) << 8;
    s_ball.y = 30 << 8;
    s_ball.vx = (left ? 1 : -1) * (int32_t)rnd(500, 900);
    s_ball.vy = 0;
    s_ball.until = now + ms;
}

bool life_playing(void)
{
    return s_ball.on;
}

void life_stop(void)
{
    s_ball.on = false;
}

static void ball_step(uint32_t now)
{
    const int32_t minx = (BALL_R + 2) << 8, maxx = (GFX_W - BALL_R - 3) << 8;
    const int32_t floor = (FLOOR_Y - BALL_R) << 8, ceil = (CEIL_Y + BALL_R) << 8;

    s_ball.vy += GRAVITY;
    s_ball.x += s_ball.vx;
    s_ball.y += s_ball.vy;

    if (s_ball.x < minx || s_ball.x > maxx) {
        s_ball.x = s_ball.x < minx ? minx : maxx;
        s_ball.vx = -s_ball.vx;
    }
    if (s_ball.y < ceil) {
        s_ball.y = ceil;
        s_ball.vy = -s_ball.vy;
    }
    if (s_ball.y > floor) {
        s_ball.y = floor;
        s_ball.vy = -s_ball.vy * 80 / 100;
        s_ball.vx = s_ball.vx * 95 / 100;
        if (abs(s_ball.vy) < 450) { /* quase parou: ele joga de novo */
            s_ball.vy = -(int32_t)rnd(1400, 1800);
            s_ball.vx = (esp_random() % 2 ? 1 : -1) * (int32_t)rnd(400, 1000);
            if (esp_random() % 3 == 0) life_say(PICK(PH_BALL), 1500, now);
        }
    }
    if ((int32_t)(now - s_ball.until) >= 0) s_ball.on = false;

    /* os olhos acompanham a bolinha */
    face_look_at(((s_ball.x >> 8) - 64) / 5, ((s_ball.y >> 8) - 58) / 7, now + 200);
}

void life_draw_ball(void)
{
    if (!s_ball.on) return;
    const int x = s_ball.x >> 8, y = s_ball.y >> 8;
    int shadow = BALL_R + 1 - (FLOOR_Y - BALL_R - y) / 12; /* sombra encolhe quando ela sobe */
    if (shadow < 1) shadow = 1;
    gfx_fill_ellipse(x, FLOOR_Y + 2, shadow, 1, C_SHADE);
    gfx_fill_circle(x, y, BALL_R, C_BALL);
    gfx_fill_circle(x - 2, y - 2, 1, C_SHINE);
}

/* ── decisão por quadro ──────────────────────────────────────────────── */

face_expr_t life_update(uint32_t now, face_expr_t mood, const life_ctx_t *c)
{
    const bool resting = mood == FACE_SLEEPING || mood == FACE_SLEEPY;
    const bool idle = mood == FACE_NEUTRAL || mood == FACE_BORED;

    /* Entediado brinca mais vezes; de boa, de vez em quando. */
    if (!s_ball.on && idle && !resting && (int32_t)(now - s_next_play) >= 0) {
        life_play_ball(now, rnd(8000, 12000));
        s_next_play = now + (mood == FACE_BORED ? rnd(45000, 90000) : rnd(180000, 480000));
    }
    if (!s_ball.on && !resting && !life_speech(now) && (int32_t)(now - s_next_chatter) >= 0) {
        chatter(now, c);
        s_next_chatter = now + rnd(90000, 240000);
    }

    if (s_ball.on) {
        ball_step(now);
        return FACE_HAPPY;
    }
    return mood;
}
