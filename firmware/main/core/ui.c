#include "ui.h"

#include <stdio.h>
#include <string.h>
#include <time.h>
#include "app_state.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "face.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gfx.h"
#include "hal.h"
#include "net.h"
#include "ws_client.h"

#define FRAME_MS        40 /* 25 fps — o núcleo é único, 60 fps não (seção 13) */
#define LONG_PRESS_MS   1000
#define AGENDA_VIEW_MS  10000
#define DEMO_MS         4000
#define PET_MS          3000
#define WORRY_BEFORE_MS (15 * 60 * 1000)
#define OFFLINE_GRACE_MS 20000
#define WAIT_BORED_MS   (15 * 60 * 1000) /* sem resposta há 15 min: entediado */
#define WAIT_SAD_MS     (60 * 60 * 1000) /* há 1 h: triste */
#define NIGHT_BRIGHTNESS 90

#define C_BG     GFX_RGB(0, 0, 0)
#define C_TEXT   GFX_RGB(235, 235, 235)
#define C_DIM    GFX_RGB(120, 130, 150)
#define C_FAINT  GFX_RGB(50, 56, 70)
#define C_ACCENT GFX_RGB(90, 230, 240)
#define C_WARN   GFX_RGB(255, 196, 0)
#define C_WARN2  GFX_RGB(255, 130, 0)
#define C_OK     GFX_RGB(60, 220, 120)
#define C_ERR    GFX_RGB(255, 80, 80)
#define C_INK    GFX_RGB(25, 20, 10) /* texto sobre a faixa amarela */

typedef enum { VIEW_FACE, VIEW_ALERT, VIEW_AGENDA } view_t;

typedef struct {
    bool down;
    bool long_fired;
    uint32_t since;
} btn_state_t;

static const char *TAG = "ui";
static const char *const WEEKDAYS[] = {"dom", "seg", "ter", "qua", "qui", "sex", "sáb"};

static app_snapshot_t s_snap;
static view_t s_view = VIEW_FACE;
static uint32_t s_view_since;
static alert_t s_alert;
static char s_last_alert_id[ROBO_ID_MAX_BYTES + 1];

static face_expr_t s_override = FACE__COUNT; /* FACE__COUNT = sem expressão forçada */
static uint32_t s_override_until;
static bool s_demo;
static int s_demo_idx = -1;

static uint32_t s_next_joy, s_joy_until;
static uint32_t s_offline_since;
static btn_state_t s_btn[HAL_BTN_COUNT];

/* ── utilidades ──────────────────────────────────────────────────────── */

static uint32_t rnd(uint32_t lo, uint32_t hi)
{
    return lo + esp_random() % (hi - lo + 1);
}

static void local_tm(int64_t epoch_ms, struct tm *out)
{
    const time_t t = (time_t)(epoch_ms / 1000);
    localtime_r(&t, out);
}

/* 0 = hoje, 1 = amanhã… (pelo calendário local, não por 24 h corridas) */
static int day_offset(int64_t ms, int64_t now_ms)
{
    struct tm a, b;
    local_tm(now_ms, &a);
    local_tm(ms, &b);
    a.tm_hour = a.tm_min = a.tm_sec = 0;
    b.tm_hour = b.tm_min = b.tm_sec = 0;
    a.tm_isdst = b.tm_isdst = -1;
    const time_t ta = mktime(&a), tb = mktime(&b);
    return (int)((tb - ta + 43200) / 86400);
}

static void fmt_hhmm(int64_t ms, char *buf, size_t n)
{
    struct tm tm;
    local_tm(ms, &tm);
    snprintf(buf, n, "%02d:%02d", tm.tm_hour, tm.tm_min);
}

static void fmt_day(int64_t ms, int day, char *buf, size_t n)
{
    if (day == 0) {
        strlcpy(buf, "hoje", n);
    } else if (day == 1) {
        strlcpy(buf, "amanhã", n);
    } else {
        struct tm tm;
        local_tm(ms, &tm);
        snprintf(buf, n, "%s %02d/%02d", WEEKDAYS[tm.tm_wday], tm.tm_mday, tm.tm_mon + 1);
    }
}

static bool is_night(int64_t wall_ms)
{
    struct tm tm;
    local_tm(wall_ms, &tm);
    return tm.tm_hour >= 23 || tm.tm_hour < 7;
}

/* Próximo compromisso com horário que ainda não terminou. */
static const agenda_item_t *next_timed(int64_t wall_ms)
{
    for (int i = 0; i < s_snap.n_agenda; i++) {
        const agenda_item_t *a = &s_snap.agenda[i];
        if (!a->all_day && a->end_ms > wall_ms) return a;
    }
    return NULL;
}

/* Rodapé: próximo com horário; se não houver, o primeiro de dia inteiro. */
static const agenda_item_t *next_for_footer(int64_t wall_ms)
{
    const agenda_item_t *a = next_timed(wall_ms);
    if (a) return a;
    for (int i = 0; i < s_snap.n_agenda; i++) {
        if (s_snap.agenda[i].end_ms > wall_ms) return &s_snap.agenda[i];
    }
    return NULL;
}

static void set_view(view_t v, uint32_t now)
{
    s_view = v;
    s_view_since = now;
}

static void set_override(face_expr_t e, uint32_t ms, uint32_t now)
{
    s_override = e;
    s_override_until = now + ms;
}

/* ── botões ──────────────────────────────────────────────────────────── */

static robo_btn_t to_proto(hal_btn_t b)
{
    switch (b) {
    case HAL_BTN_KEY1: return ROBO_BTN_KEY1;
    case HAL_BTN_KEY2: return ROBO_BTN_KEY2;
    default: return ROBO_BTN_BOOT;
    }
}

static void on_button(hal_btn_t b, robo_btn_ev_t ev, uint32_t now)
{
    ESP_LOGI(TAG, "botão %s (%s)", robo_btn_name(to_proto(b)), robo_btn_ev_name(ev));
    ws_client_send_button(to_proto(b), ev);
    if (ev != ROBO_BTN_EV_SHORT) return;

    if (s_view == VIEW_ALERT) { /* qualquer botão dispensa o alerta */
        set_view(VIEW_FACE, now);
        s_demo = false;
        set_override(FACE_HAPPY, 1500, now);
        return;
    }
    switch (b) {
    case HAL_BTN_KEY1: /* agenda */
        set_view(s_view == VIEW_AGENDA ? VIEW_FACE : VIEW_AGENDA, now);
        break;
    case HAL_BTN_KEY2: /* carinho */
        set_view(VIEW_FACE, now);
        s_demo = false;
        set_override(FACE_LOVE, PET_MS, now);
        break;
    case HAL_BTN_BOOT: /* mostruário das expressões */
        set_view(VIEW_FACE, now);
        s_demo_idx = (s_demo_idx + 1) % FACE__COUNT;
        s_demo = true;
        set_override((face_expr_t)s_demo_idx, DEMO_MS, now);
        break;
    default:
        break;
    }
}

static void poll_buttons(uint32_t now)
{
    for (int i = 0; i < HAL_BTN_COUNT; i++) {
        btn_state_t *b = &s_btn[i];
        const bool down = hal_button_down((hal_btn_t)i);
        if (down && !b->down) {
            b->down = true;
            b->since = now;
            b->long_fired = false;
        } else if (down && !b->long_fired && now - b->since >= LONG_PRESS_MS) {
            b->long_fired = true;
            on_button((hal_btn_t)i, ROBO_BTN_EV_LONG, now);
        } else if (!down && b->down) {
            b->down = false;
            if (!b->long_fired) on_button((hal_btn_t)i, ROBO_BTN_EV_SHORT, now);
        }
    }
}

/* ── estado ──────────────────────────────────────────────────────────── */

static void check_events(uint32_t now)
{
    /* Reação do servidor (emoção da resposta, "respondeu!") — o alerta tem prioridade. */
    if (s_snap.has_react && s_view != VIEW_ALERT && (int)s_snap.react_face < (int)FACE__COUNT) {
        s_demo = false;
        set_override((face_expr_t)s_snap.react_face, s_snap.react_ms, now);
    }
    if (!s_snap.has_alert || strcmp(s_snap.alert.id, s_last_alert_id) == 0) return;
    strlcpy(s_last_alert_id, s_snap.alert.id, sizeof(s_last_alert_id));
    s_alert = s_snap.alert;
    s_demo = false;
    s_override = FACE__COUNT;
    set_view(VIEW_ALERT, now);
}

/* Há quanto tempo o robô espera resposta do dono (0 = não espera). */
static int64_t waiting_for(int64_t wall_ms, bool clock_ok)
{
    const int64_t since = s_snap.chat.waiting_since_ms;
    if (!since || !clock_ok || !s_snap.server_up) return 0;
    return wall_ms > since ? wall_ms - since : 1;
}

static void expire(uint32_t now)
{
    const uint32_t age = now - s_view_since;
    if (s_view == VIEW_ALERT && age > s_alert.ttl_ms) set_view(VIEW_FACE, now);
    if (s_view == VIEW_AGENDA && age > AGENDA_VIEW_MS) set_view(VIEW_FACE, now);
    if (s_override < FACE__COUNT && (int32_t)(now - s_override_until) >= 0) {
        s_override = FACE__COUNT;
        s_demo = false;
    }
}

static face_expr_t pick_mood(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    const bool online = s_snap.wifi_up && s_snap.server_up;
    if (online) s_offline_since = 0;
    else if (!s_offline_since) s_offline_since = now ? now : 1;

    if (s_view == VIEW_ALERT) return FACE_SURPRISED;
    if (s_override < FACE__COUNT) return s_override;
    if (!online) return now - s_offline_since > OFFLINE_GRACE_MS ? FACE_SAD : FACE_NEUTRAL;
    if (s_snap.chat.thinking) return FACE_THINKING;

    if (clock_ok) {
        struct tm tm;
        local_tm(wall_ms, &tm);
        if (is_night(wall_ms)) return FACE_SLEEPING;
        if (tm.tm_hour == 22) return FACE_SLEEPY;
        const agenda_item_t *nx = next_timed(wall_ms);
        if (nx && nx->start_ms > wall_ms && nx->start_ms - wall_ms <= WORRY_BEFORE_MS) return FACE_WORRIED;
    }

    /* Mandou mensagem e ninguém respondeu: expectativa → tédio → tristeza. */
    const int64_t waiting = waiting_for(wall_ms, clock_ok);
    if (waiting) {
        if (waiting < WAIT_BORED_MS) return FACE_NEUTRAL; /* o balão na tela já diz "tenho msg" */
        return waiting < WAIT_SAD_MS ? FACE_BORED : FACE_SAD;
    }

    /* de vez em quando fica feliz à toa — é um bichinho, afinal */
    if (now >= s_next_joy) {
        s_joy_until = now + 3500;
        s_next_joy = now + rnd(45000, 120000);
    }
    return now < s_joy_until ? FACE_HAPPY : FACE_NEUTRAL;
}

/* ── telas ───────────────────────────────────────────────────────────── */

/* Balãozinho de "tenho mensagem pra você" no canto; pisca quando a espera já passou do ponto. */
static void render_bubble(uint32_t now, int64_t waiting)
{
    if (waiting >= WAIT_BORED_MS && (now / 600) % 2) return;
    const int x = 4, y = 4;
    gfx_fill_round_rect(x, y, 20, 13, 5, C_ACCENT);
    gfx_fill_triangle(x + 4, y + 11, x + 10, y + 11, x + 3, y + 17, C_ACCENT);
    for (int i = 0; i < 3; i++) gfx_fill_circle(x + 5 + i * 5, y + 6, 1, C_BG);
}

static void render_status_bar(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    char hhmm[16] = "--:--";
    if (clock_ok) fmt_hhmm(wall_ms, hhmm, sizeof(hhmm));
    gfx_text_center(64, 3, hhmm, C_TEXT, 2);
    const uint16_t dot = s_snap.server_up ? C_OK : s_snap.wifi_up ? C_WARN : C_ERR;
    gfx_fill_circle(121, 10, 3, dot);
    const int64_t waiting = waiting_for(wall_ms, clock_ok);
    if (waiting) render_bubble(now, waiting);
}

static void render_footer(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    const int y1 = 102, y2 = 115;
    if (s_demo) {
        gfx_text_center(64, y1 + 6, face_name(s_override), C_DIM, 1);
        return;
    }
    if (!s_snap.wifi_up || !s_snap.server_up) {
        const bool trying = !s_offline_since || now - s_offline_since < OFFLINE_GRACE_MS;
        const char *msg = !s_snap.wifi_up ? (trying ? "conectando..." : "sem Wi-Fi") : "sem servidor";
        gfx_text_center(64, y1 + 6, msg, C_DIM, 1);
        return;
    }
    if (s_snap.chat.thinking) {
        gfx_text_center(64, y1 + 6, "pensando...", C_ACCENT, 1);
        return;
    }
    const int64_t waiting = waiting_for(wall_ms, clock_ok);
    if (waiting && s_snap.chat.preview[0]) {
        char when[32];
        const int min = (int)(waiting / 60000);
        if (min < 1) strlcpy(when, "te mandei msg!", sizeof(when));
        else if (min < 60) snprintf(when, sizeof(when), "te mandei msg há %d min", min);
        else snprintf(when, sizeof(when), "esperando há %dh%02d", min / 60, min % 60);
        gfx_text_fit(4, y1, 120, s_snap.chat.preview, C_TEXT, 1);
        gfx_text(4, y2, when, C_ACCENT, 1);
        return;
    }
    const agenda_item_t *nx = clock_ok ? next_for_footer(wall_ms) : NULL;
    if (!nx) {
        gfx_text_center(64, y1 + 6, "agenda livre", C_DIM, 1);
        return;
    }

    char label[16], rel[40];
    const int day = day_offset(nx->start_ms, wall_ms);
    if (nx->all_day) {
        strlcpy(label, "dia", sizeof(label));
        fmt_day(nx->start_ms, day < 0 ? 0 : day, rel, sizeof(rel));
        strlcat(rel, ", dia todo", sizeof(rel));
    } else {
        fmt_hhmm(nx->start_ms, label, sizeof(label));
        const int64_t d = nx->start_ms - wall_ms;
        if (d <= 0) {
            char end[16];
            fmt_hhmm(nx->end_ms, end, sizeof(end));
            snprintf(rel, sizeof(rel), "agora, até %s", end);
        } else if (day == 0) {
            const int min = (int)((d + 59999) / 60000);
            if (min < 60) snprintf(rel, sizeof(rel), "em %d min", min);
            else snprintf(rel, sizeof(rel), "em %dh%02d", min / 60, min % 60);
        } else {
            fmt_day(nx->start_ms, day, rel, sizeof(rel));
        }
    }

    const int lw = gfx_text(4, y1, label, C_ACCENT, 1);
    gfx_text_fit(4 + lw + 4, y1, 124 - (4 + lw + 4), nx->title, C_TEXT, 1);
    gfx_text(4, y2, rel, C_DIM, 1);
}

static void render_face_view(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    render_status_bar(now, wall_ms, clock_ok);
    face_draw(64, 60, now);
    render_footer(now, wall_ms, clock_ok);
}

static void render_alert_view(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    face_draw(64, 32, now);

    const uint32_t age = now - s_view_since;
    const bool flash = age < 6000 && (age / 350) % 2;
    gfx_fill_round_rect(0, 68, GFX_W, GFX_H - 68, 10, flash ? C_WARN2 : C_WARN);

    char big[32];
    if (s_alert.at_ms > 0 && clock_ok) {
        const int64_t d = s_alert.at_ms - wall_ms;
        if (d > 60000) snprintf(big, sizeof(big), "em %d min", (int)((d + 59999) / 60000));
        else if (d > -60000) strlcpy(big, "AGORA!", sizeof(big));
        else snprintf(big, sizeof(big), "há %d min", (int)(-d / 60000));
    } else {
        strlcpy(big, s_alert.sub[0] ? s_alert.sub : "lembrete", sizeof(big));
    }
    gfx_text_center(64, 75, big, C_INK, 2);
    gfx_text_wrap(6, 97, 116, s_alert.title, C_INK, 1, 2);
    if (s_alert.sub[0] && s_alert.at_ms > 0) gfx_text_center(64, 119, s_alert.sub, C_INK, 1);
}

static void render_agenda_view(int64_t wall_ms, bool clock_ok)
{
    gfx_text(4, 4, "Agenda", C_ACCENT, 1);
    gfx_fill_rect(4, 15, 120, 1, C_FAINT);

    if (!s_snap.server_up) {
        gfx_text_center(64, 60, "sem conexão", C_DIM, 1);
        return;
    }

    int y = 20, last_day = 0, shown = 0;
    for (int i = 0; i < s_snap.n_agenda; i++) {
        const agenda_item_t *a = &s_snap.agenda[i];
        if (clock_ok && a->end_ms <= wall_ms) continue;
        int day = clock_ok ? day_offset(a->start_ms, wall_ms) : 0;
        if (day < 0) day = 0;

        if (day != last_day) {
            if (y > GFX_H - 22) break;
            char dl[24];
            fmt_day(a->start_ms, day, dl, sizeof(dl));
            gfx_text(4, y, dl, C_DIM, 1);
            y += 11;
            last_day = day;
        }
        if (y > GFX_H - 10) break;

        char label[16];
        if (a->all_day) strlcpy(label, "dia", sizeof(label));
        else fmt_hhmm(a->start_ms, label, sizeof(label));
        const bool ongoing = clock_ok && a->start_ms <= wall_ms;
        gfx_text(4, y, label, ongoing ? C_OK : C_ACCENT, 1);
        gfx_text_fit(44, y, 80, a->title, C_TEXT, 1);
        y += 12;
        shown++;
    }

    char cnt[12];
    snprintf(cnt, sizeof(cnt), "%d", shown);
    gfx_text(124 - gfx_text_width(cnt, 1), 4, cnt, C_DIM, 1);
    if (!shown) {
        gfx_text_center(64, 56, "Nada na agenda", C_DIM, 1);
        gfx_text_center(64, 72, ":)", C_ACCENT, 2);
    }
}

/* ── laço ────────────────────────────────────────────────────────────── */

/* O webapp espelha a cara da tela: avisa o servidor quando muda (e de novo a cada reconexão). */
static void report_face(void)
{
    static int reported = -1;
    static bool was_up;
    if (s_snap.server_up && !was_up) reported = -1;
    was_up = s_snap.server_up;
    const face_expr_t shown = face_get();
    if (s_snap.server_up && (int)shown != reported) {
        ws_client_send_face((robo_face_t)shown);
        reported = shown;
    }
}

static void ui_task(void *arg)
{
    gfx_init();
    face_init();
    s_next_joy = (uint32_t)(esp_timer_get_time() / 1000) + 30000;

    TickType_t last_wake = xTaskGetTickCount();
    for (;;) {
        const uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
        const bool clock_ok = net_time_valid();
        const int64_t wall = net_epoch_ms();

        app_snapshot(&s_snap);
        check_events(now);
        poll_buttons(now);
        expire(now);
        face_set(pick_mood(now, wall, clock_ok));
        report_face();

        const bool dim = clock_ok && is_night(wall) && s_view != VIEW_ALERT;
        gfx_set_brightness(dim ? NIGHT_BRIGHTNESS : 255);
        gfx_clear(C_BG);
        switch (s_view) {
        case VIEW_FACE: render_face_view(now, wall, clock_ok); break;
        case VIEW_ALERT: render_alert_view(now, wall, clock_ok); break;
        case VIEW_AGENDA: render_agenda_view(wall, clock_ok); break;
        }
        hal_display_blit(gfx_fb(), 0, 0, GFX_W, GFX_H);

        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(FRAME_MS));
    }
}

void ui_start(void)
{
    xTaskCreate(ui_task, "ui", 6144, NULL, 5, NULL);
}
