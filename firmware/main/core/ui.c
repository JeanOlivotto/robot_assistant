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
#include "life.h"
#include "net.h"
#include "ws_client.h"

#define FRAME_MS        40 /* 25 fps — o núcleo é único, 60 fps não (seção 13) */
#define LONG_PRESS_MS   1000
#define DOUBLE_CLICK_MS 400 /* dois toques no KEY1 dentro disso = uso do Claude */
#define AGENDA_VIEW_MS  10000
#define CLAUDE_VIEW_MS  12000
#define DEMO_MS         4000
#define PET_MS          3000
#define WORRY_BEFORE_MS (15 * 60 * 1000)
#define OFFLINE_GRACE_MS 20000
#define WAIT_BORED_MS   (15 * 60 * 1000) /* sem resposta há 15 min: entediado */
#define WAIT_SAD_MS     (60 * 60 * 1000) /* há 1 h: triste */
#define FOOTER_NEAR_MS        (30 * 60 * 1000) /* rodapé mostra o compromisso a partir de 30 min antes */
#define FOOTER_AFTER_START_MS (5 * 60 * 1000)  /* ...até 5 min depois de começar */
#define AGENDA_PEEK_MS        20000            /* agenda mudou: mostra o próximo por 20 s */
#define NIGHT_BRIGHTNESS 90
/* O backlight não tem controle nesta placa: escurecer os pixels não poupa nada, só apaga o
   desenho. A economia do repouso vem do rádio em modo econômico e da animação lenta. */
#define SLEEP_BRIGHTNESS 110
#define SLEEP_FRAME_MS   200 /* dormindo, anima devagar (5 fps) — gasta menos CPU */
/* Sono sozinho, como um bichinho: sem ninguém mexer nele, boceja e depois dorme. */
#define IDLE_SLEEP_MS       (5 * 60 * 1000) /* de dia: 5 min sem interação */
#define IDLE_SLEEP_NIGHT_MS (60 * 1000)     /* de noite: 1 min */
#define DROWSY_MS           30000           /* 30 s bocejando antes de dormir */
#define LONG_NAP_MS         (30 * 60 * 1000) /* dormiu mais que isso: acorda com "bom dia" */

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
#define C_BUBBLE GFX_RGB(38, 46, 62) /* balão de fala */
#define C_PHONE  GFX_RGB(120, 200, 255) /* fones */
#define C_NOTE   GFX_RGB(180, 130, 255) /* nota musical */
#define C_CLAUDE GFX_RGB(217, 119, 87) /* terracota do Claude */

typedef enum { VIEW_FACE, VIEW_ALERT, VIEW_AGENDA, VIEW_CLAUDE } view_t;

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
static bool s_sleeping; /* modo repouso: rádio em economia e animação lenta até acordar */
static uint32_t s_last_touch;  /* última interação (botão, mensagem, alerta, música) */
static uint32_t s_slept_at;
static bool s_drowsy;

static uint32_t s_next_joy, s_joy_until;
static uint32_t s_offline_since;
static uint32_t s_agenda_peek_until;
static btn_state_t s_btn[HAL_BTN_COUNT];
static uint32_t s_key1_clicked; /* quando foi o último toque curto no KEY1 (0 = nenhum) */
static uint32_t s_key2_clicked; /* idem para o KEY2, que alterna o modo hacker em dois toques */

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
    if (v != VIEW_FACE) life_stop();
}

static void set_override(face_expr_t e, uint32_t ms, uint32_t now)
{
    s_override = e;
    s_override_until = now + ms;
}

static void set_sleeping(bool on, uint32_t now)
{
    s_last_touch = now;
    s_drowsy = false;
    if (on == s_sleeping) return;
    s_sleeping = on;
    if (on) s_slept_at = now;
    net_set_power_save(on);
}

/* Alguém mexeu com ele: acorda (se dormia) e recomeça a contar o tempo até o próximo cochilo. */
static void touch(uint32_t now)
{
    s_last_touch = now;
    s_drowsy = false;
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
    touch(now);

    /* Dois toques no KEY2 alternam o modo hacker. Vem antes de tudo porque o primeiro toque
       botou o robô para dormir, e o bloco abaixo engoliria o segundo só para acordá-lo. */
    if (ev == ROBO_BTN_EV_SHORT && b == HAL_BTN_KEY2 && s_key2_clicked && now - s_key2_clicked <= DOUBLE_CLICK_MS) {
        s_key2_clicked = 0;
        if (s_sleeping) set_sleeping(false, now);
        set_view(VIEW_FACE, now);
        s_demo = false;
        s_override = FACE__COUNT;
        life_stop();
        const bool on = !face_hacker();
        face_set_hacker(on);
        life_say(on ? "modo hacker" : "voltei ao normal", 2500, now);
        ESP_LOGI(TAG, "modo hacker %s", on ? "ligado" : "desligado");
        return;
    }

    if (s_sleeping) { /* dormindo: qualquer botão acorda o robô */
        const bool long_nap = now - s_slept_at > LONG_NAP_MS;
        set_sleeping(false, now);
        set_view(VIEW_FACE, now);
        s_demo = false;
        set_override(FACE_HAPPY, 1500, now);
        life_say(long_nap ? "bom dia!" : "hã? oi!", 2000, now);
        return;
    }
    if (ev == ROBO_BTN_EV_LONG && b == HAL_BTN_KEY1 && s_view != VIEW_ALERT) { /* segurar KEY1: uso do Claude */
        set_view(s_view == VIEW_CLAUDE ? VIEW_FACE : VIEW_CLAUDE, now);
        return;
    }
    if (ev == ROBO_BTN_EV_LONG && b == HAL_BTN_BOOT && s_view != VIEW_ALERT) { /* segurar BOOT: bolinha */
        set_view(VIEW_FACE, now);
        s_demo = false;
        s_override = FACE__COUNT;
        life_play_ball(now, 12000);
        return;
    }
    if (ev == ROBO_BTN_EV_LONG && b == HAL_BTN_KEY2 && s_view != VIEW_ALERT) { /* segurar KEY2: carinho */
        set_view(VIEW_FACE, now);
        s_demo = false;
        life_stop();
        set_override(FACE_LOVE, PET_MS, now);
        life_pet(now);
        return;
    }
    if (ev != ROBO_BTN_EV_SHORT) return;

    if (s_view == VIEW_ALERT) { /* qualquer botão dispensa o alerta */
        set_view(VIEW_FACE, now);
        s_demo = false;
        set_override(FACE_HAPPY, 1500, now);
        return;
    }
    switch (b) {
    case HAL_BTN_KEY1:
        /* Um toque abre a agenda; dois toques seguidos trocam para o uso do Claude.
           A agenda abre já no primeiro toque (nada de esperar para ver se vem o segundo):
           quem deu dois cliques vê a agenda por um instante e a tela troca. */
        if (s_key1_clicked && now - s_key1_clicked <= DOUBLE_CLICK_MS) {
            s_key1_clicked = 0;
            set_view(VIEW_CLAUDE, now);
        } else {
            s_key1_clicked = now;
            set_view(s_view == VIEW_AGENDA ? VIEW_FACE : VIEW_AGENDA, now);
        }
        break;
    case HAL_BTN_KEY2: /* um toque dorme; o segundo, logo em seguida, liga o modo hacker */
        s_key2_clicked = now;
        set_view(VIEW_FACE, now);
        s_demo = false;
        s_override = FACE__COUNT;
        life_stop();
        set_sleeping(true, now);
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
    /* Acorda quando chega alerta, quando o robô vai falar algo ou reagir. */
    if (s_snap.has_alert || s_snap.has_say || s_snap.has_react) {
        if (s_sleeping) set_sleeping(false, now);
        touch(now);
    }
    /* Pensando na resposta ou começou a tocar música: tem gente mexendo, não é hora de dormir. */
    static bool was_playing;
    const bool playing = s_snap.music.playing;
    if (playing && !was_playing && s_sleeping) set_sleeping(false, now);
    if (playing || s_snap.chat.thinking) touch(now);
    was_playing = playing;
    /* Reação do servidor (emoção da resposta, "respondeu!") — o alerta tem prioridade. */
    if (s_snap.has_react && s_view != VIEW_ALERT && (int)s_snap.react_face < (int)FACE__COUNT) {
        s_demo = false;
        set_override((face_expr_t)s_snap.react_face, s_snap.react_ms, now);
    }
    if (s_snap.has_say && s_snap.say[0]) life_say(s_snap.say, s_snap.say_ms, now);
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
    if (s_view == VIEW_CLAUDE && age > CLAUDE_VIEW_MS) set_view(VIEW_FACE, now);
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
    if (s_drowsy) return FACE_SLEEPY;

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

/* Sinal do Wi-Fi em 4 barras. Verde: servidor ok; amarelo: Wi-Fi sem servidor; X vermelho: sem Wi-Fi. */
static void render_wifi(int x, int bottom, int rssi)
{
    const int level = !s_snap.wifi_up ? 0 : rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
    const uint16_t on = s_snap.server_up ? C_OK : C_WARN;
    for (int i = 0; i < 4; i++) {
        const int h = 3 + i * 3;
        gfx_fill_rect(x + i * 3, bottom - h, 2, h, i < level ? on : C_FAINT);
    }
    if (!s_snap.wifi_up) {
        gfx_thick_line(x + 5, bottom - 11, x + 11, bottom - 5, 1, C_ERR);
        gfx_thick_line(x + 5, bottom - 5, x + 11, bottom - 11, 1, C_ERR);
    }
}

/* Raiozinho de "ligado na USB". */
static void render_usb(int x, int top)
{
    gfx_thick_line(x + 3, top, x, top + 6, 2, C_WARN);
    gfx_thick_line(x, top + 6, x + 4, top + 6, 2, C_WARN);
    gfx_thick_line(x + 4, top + 6, x + 1, top + 12, 2, C_WARN);
}

static void render_status_bar(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    static int rssi;
    static hal_power_t power;
    static uint32_t read_at;
    if (!read_at || now - read_at > 2000) { /* não precisa ler o rádio a cada quadro */
        rssi = net_rssi();
        power = hal_power_read();
        read_at = now ? now : 1;
    }

    char hhmm[16] = "--:--";
    if (clock_ok) fmt_hhmm(wall_ms, hhmm, sizeof(hhmm));
    gfx_text_center(64, 3, hhmm, C_TEXT, 2);
    render_wifi(113, 15, rssi);
    if (power.usb) render_usb(104, 3);
    const int64_t waiting = waiting_for(wall_ms, clock_ok);
    if (waiting) render_bubble(now, waiting);
}

/* Balão de fala no rodapé, com o bico apontando para a boca. */
static void render_speech(const char *text)
{
    const int x = 3, y = 97, w = GFX_W - 6, h = 29;
    gfx_fill_round_rect(x, y, w, h, 8, C_BUBBLE);
    gfx_fill_triangle(58, y + 1, 70, y + 1, 64, y - 5, C_BUBBLE);
    if (gfx_text_width(text, 1) <= w - 12) gfx_text_center(64, y + 10, text, C_TEXT, 1);
    else gfx_text_wrap(x + 6, y + 4, w - 12, text, C_TEXT, 1, 2);
}

/* Sem compromisso para mostrar: a data, por extenso. */
static void render_date(int64_t wall_ms, bool clock_ok)
{
    static const char *const DAYS[] = {"domingo", "segunda-feira", "terça-feira", "quarta-feira",
                                       "quinta-feira", "sexta-feira", "sábado"};
    static const char *const MONTHS[] = {"janeiro", "fevereiro", "março", "abril", "maio", "junho",
                                         "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"};
    if (!clock_ok) return;
    struct tm tm;
    local_tm(wall_ms, &tm);
    char line[32];
    snprintf(line, sizeof(line), "%d de %s", tm.tm_mday, MONTHS[tm.tm_mon]);
    gfx_text_center(64, 103, DAYS[tm.tm_wday], C_DIM, 1);
    gfx_text_center(64, 115, line, C_DIM, 1);
}

static void render_footer(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    const int y1 = 102, y2 = 115;
    if (s_demo) {
        gfx_text_center(64, y1 + 6, face_name(s_override), C_DIM, 1);
        return;
    }
    const char *speech = life_speech(now);
    if (speech) {
        render_speech(speech);
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
    /* O próximo compromisso só aparece perto da hora, ou por uns segundos quando a agenda muda. */
    const agenda_item_t *nx = clock_ok ? next_for_footer(wall_ms) : NULL;
    const bool near = nx && !nx->all_day && nx->start_ms - wall_ms <= FOOTER_NEAR_MS &&
                      wall_ms - nx->start_ms <= FOOTER_AFTER_START_MS;
    const bool peek = (int32_t)(s_agenda_peek_until - now) > 0;
    if (!nx || !(near || peek)) {
        render_date(wall_ms, clock_ok);
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

/* Modo repouso: só a carinha dormindo, um relógio pequeno e "zzz", em tom suave. */
static void render_sleep_view(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    if (clock_ok) {
        char hhmm[8];
        fmt_hhmm(wall_ms, hhmm, sizeof(hhmm));
        gfx_text_center(64, 6, hhmm, C_DIM, 1);
    }
    face_draw(64, 64, now);
    gfx_text_center(64, 116, "zzz", C_FAINT, 1);
    const int64_t waiting = waiting_for(wall_ms, clock_ok);
    if (waiting) render_bubble(now, waiting); /* dormindo, mas ainda avisa que tem mensagem */
}

/* Uma nota musical simples que balança. */
static void draw_note(int x, int y, uint16_t color)
{
    gfx_fill_ellipse(x, y, 4, 3, color);
    gfx_fill_rect(x + 3, y - 13, 2, 13, color);
    gfx_fill_triangle(x + 4, y - 13, x + 4, y - 7, x + 10, y - 10, color);
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

/* Modo música: carinha curtindo, fones de ouvido, notinhas e o que está tocando. */
/* Atualizando o firmware: a tela para tudo e vira barra de progresso até reiniciar. */
static void render_ota_view(uint32_t now)
{
    const ota_state_t *o = &s_snap.ota;
    const bool bad = o->phase == ROBO_OTA_ERROR;
    const bool ready = o->phase == ROBO_OTA_DONE;
    const uint16_t tint = bad ? C_ERR : ready ? C_OK : C_ACCENT;

    gfx_text_center(64, 8, bad ? "Ops" : "Atualizando", tint, 1);
    if (o->version[0]) {
        char v[ROBO_OTA_VERSION_MAX_BYTES + 10];
        snprintf(v, sizeof(v), "v%s", o->version);
        gfx_text_center(64, 21, v, C_DIM, 1);
    }

    /* Caixinha com uma seta para baixo — "chegando coisa nova". */
    const int cx = 64, cy = 52;
    const int bob = bad || ready ? 0 : ((now / 400) % 2 ? 0 : -2);
    gfx_fill_round_rect(cx - 16, cy - 16 + bob, 32, 26, 5, C_FAINT);
    if (bad) {
        gfx_thick_line(cx - 7, cy - 8, cx + 7, cy + 6, 3, C_ERR);
        gfx_thick_line(cx + 7, cy - 8, cx - 7, cy + 6, 3, C_ERR);
    } else if (ready) {
        gfx_thick_line(cx - 7, cy - 1, cx - 2, cy + 5, 3, C_OK);
        gfx_thick_line(cx - 2, cy + 5, cx + 8, cy - 8, 3, C_OK);
    } else {
        gfx_fill_rect(cx - 2, cy - 11, 5, 11, C_ACCENT);
        gfx_fill_triangle(cx - 8, cy, cx + 9, cy, cx, cy + 8, C_ACCENT);
    }

    /* Barra de progresso: só o download tem porcentagem de verdade. */
    const int x = 14, y = 84, w = 100, h = 10;
    gfx_fill_round_rect(x, y, w, h, 4, C_FAINT);
    int pct = o->pct < 0 ? 0 : o->pct > 100 ? 100 : o->pct;
    if (o->phase == ROBO_OTA_START) pct = 0;
    if (ready || o->phase == ROBO_OTA_VERIFY) pct = 100;
    if (!bad && pct > 0) gfx_fill_round_rect(x, y, (w * pct) / 100 < 8 ? 8 : (w * pct) / 100, h, 4, tint);

    const char *legend;
    switch (o->phase) {
    case ROBO_OTA_START:    legend = "buscando..."; break;
    case ROBO_OTA_DOWNLOAD: legend = "baixando"; break;
    case ROBO_OTA_VERIFY:   legend = "conferindo..."; break;
    case ROBO_OTA_DONE:     legend = "pronto! reiniciando"; break;
    default:                legend = "não deu, tento depois"; break;
    }
    if (o->phase == ROBO_OTA_DOWNLOAD) {
        char line[24];
        snprintf(line, sizeof(line), "%s %d%%", legend, pct);
        gfx_text_center(64, 100, line, C_TEXT, 1);
    } else {
        gfx_text_center(64, 100, legend, bad ? C_ERR : C_TEXT, 1);
    }
    if (!bad && !ready) gfx_text_center(64, 114, "não me desligue", C_WARN, 1);
}

static void render_music_view(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    char hhmm[8] = "";
    if (clock_ok) fmt_hhmm(wall_ms, hhmm, sizeof(hhmm));
    if (hhmm[0]) gfx_text_center(64, 3, hhmm, C_DIM, 1);

    face_draw(64, 52, now);

    /* Fones: arco por cima da cabeça + as duas conchas. */
    gfx_arc_band(64, 52, 44, 44, 4, false, C_PHONE);
    gfx_fill_round_rect(14, 44, 12, 22, 5, C_PHONE);
    gfx_fill_round_rect(102, 44, 12, 22, 5, C_PHONE);

    /* Notinhas balançando. */
    const int bob = (now / 220) % 2 ? 0 : -3;
    draw_note(24, 30 + bob, C_NOTE);
    draw_note(100, 26 - bob, C_NOTE);

    const music_state_t *m = &s_snap.music;
    render_marquee(103, m->title[0] ? m->title : "tocando algo", C_TEXT, now);
    if (m->artist[0]) gfx_text_fit(4, 116, GFX_W - 8, m->artist, C_DIM, 1);
}

static void render_face_view(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    render_status_bar(now, wall_ms, clock_ok);
    face_draw(64, 60, now);
    life_draw_ball();
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

/* Cor da barra conforme o quanto já foi usado. */
static uint16_t usage_color(float pct)
{
    if (pct >= 90) return C_ERR;
    if (pct >= 75) return C_WARN2;
    if (pct >= 50) return C_WARN;
    return C_OK;
}

/* Uma janela de limite: rótulo, % grande, barra e quando renova. */
static void render_usage_window(int y, const char *label, const usage_window_t *w, int64_t wall_ms, bool clock_ok)
{
    const bool known = w->pct >= 0;
    /* Já passou da renovação: o número é da janela anterior, então o uso de agora é zero. */
    const bool renewed = known && clock_ok && w->resets_at_ms && w->resets_at_ms <= wall_ms;
    const float pct = renewed ? 0 : w->pct;

    gfx_text(4, y + 4, label, C_DIM, 1);
    char big[12];
    if (known) snprintf(big, sizeof(big), "%d%%", (int)(pct + 0.5f));
    else strlcpy(big, "--", sizeof(big));
    const uint16_t color = known ? usage_color(pct) : C_DIM;
    gfx_text(124 - gfx_text_width(big, 2), y, big, color, 2);

    const int by = y + 19, bw = 120;
    gfx_fill_round_rect(4, by, bw, 7, 3, C_FAINT);
    if (known && pct > 0) {
        int fill = (int)(bw * (pct > 100 ? 100 : pct) / 100 + 0.5f);
        if (fill < 6) fill = 6; /* arredondado precisa de um mínimo para aparecer */
        gfx_fill_round_rect(4, by, fill, 7, 3, color);
    }

    char line[40] = "";
    if (!known) {
        strlcpy(line, "sem dados ainda", sizeof(line));
    } else if (renewed) {
        strlcpy(line, "já renovou", sizeof(line));
    } else if (clock_ok && w->resets_at_ms) {
        const int64_t d = w->resets_at_ms - wall_ms;
        const int min = (int)((d + 59999) / 60000);
        char hhmm[16];
        if (min < 60) {
            snprintf(line, sizeof(line), "renova em %d min", min);
        } else if (min < 24 * 60) {
            snprintf(line, sizeof(line), "renova em %dh%02d", min / 60, min % 60);
        } else {
            struct tm tm;
            local_tm(w->resets_at_ms, &tm);
            fmt_hhmm(w->resets_at_ms, hhmm, sizeof(hhmm));
            snprintf(line, sizeof(line), "renova %s %s", WEEKDAYS[tm.tm_wday], hhmm);
        }
    }
    gfx_text_fit(4, by + 11, 120, line, C_DIM, 1);
}

/* KEY2: quanto do plano Claude já foi usado (sessão de 5 h e semana). */
static void render_claude_view(int64_t wall_ms, bool clock_ok)
{
    gfx_text(4, 4, "Claude", C_CLAUDE, 1);
    const claude_usage_t *u = &s_snap.usage;
    if (u->updated_at_ms && clock_ok) { /* idade dos números: só mudam enquanto o Claude Code roda */
        char age[24];
        const int min = (int)((wall_ms - u->updated_at_ms) / 60000);
        if (min < 1) strlcpy(age, "agora", sizeof(age));
        else if (min < 60) snprintf(age, sizeof(age), "há %d min", min);
        else if (min < 48 * 60) snprintf(age, sizeof(age), "há %dh", min / 60);
        else snprintf(age, sizeof(age), "há %d dias", min / (24 * 60));
        gfx_text(124 - gfx_text_width(age, 1), 4, age, C_DIM, 1);
    }
    gfx_fill_rect(4, 15, 120, 1, C_FAINT);

    if (!s_snap.has_usage) {
        gfx_text_center(64, 56, s_snap.server_up ? "carregando..." : "sem conexão", C_DIM, 1);
        return;
    }
    if (!u->updated_at_ms) {
        gfx_text_center(64, 48, "Ainda sem dados", C_TEXT, 1);
        gfx_text_center(64, 64, "use o Claude Code", C_DIM, 1);
        gfx_text_center(64, 76, "que eu aprendo :)", C_DIM, 1);
        return;
    }
    render_usage_window(22, "sessão 5h", &u->five_hour, wall_ms, clock_ok);
    render_usage_window(76, "semana", &u->seven_day, wall_ms, clock_ok);
}

/* ── laço ────────────────────────────────────────────────────────────── */

/* Agenda mudou (evento novo, removido, ao ligar)? Mostra o próximo no rodapé por alguns segundos. */
static void track_agenda(uint32_t now)
{
    static uint32_t last_sig;
    uint32_t sig = 2166136261u; /* FNV-1a dos ids */
    for (int i = 0; i < s_snap.n_agenda; i++) {
        for (const char *p = s_snap.agenda[i].id; *p; p++) sig = (sig ^ (uint8_t)*p) * 16777619u;
    }
    if (sig != last_sig) {
        last_sig = sig;
        if (s_snap.n_agenda) s_agenda_peek_until = now + AGENDA_PEEK_MS;
    }
}

/* Humor do momento + "vida" (bolinha, falas) quando a tela do rosto está livre. */
static face_expr_t live_mood(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    const face_expr_t mood = pick_mood(now, wall_ms, clock_ok);
    const bool free = s_view == VIEW_FACE && !s_demo && s_override == FACE__COUNT && mood != FACE_THINKING;
    if (!free) {
        life_stop();
        return mood;
    }
    const agenda_item_t *nx = clock_ok ? next_timed(wall_ms) : NULL;
    /* só comenta o compromisso quando falta menos de 1 h */
    const bool soon = nx && nx->start_ms > wall_ms && nx->start_ms - wall_ms <= 60 * 60 * 1000;
    const life_ctx_t ctx = {
        .online = s_snap.wifi_up && s_snap.server_up,
        .waiting = waiting_for(wall_ms, clock_ok) > 0,
        .clock_ok = clock_ok,
        .wall_ms = wall_ms,
        .next_title = soon ? nx->title : NULL,
        .next_start_ms = soon ? nx->start_ms : 0,
    };
    return life_update(now, mood, &ctx);
}

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

/* Sem interação por um tempo, fica com sono e dorme sozinho (mais cedo de noite).
   Alerta, agenda aberta ou expressão forçada contam como gente mexendo; a bolinha e a falação
   são dele mesmo, então só adiam o cochilo até ele terminar. */
static void auto_sleep(uint32_t now, int64_t wall_ms, bool clock_ok)
{
    static uint32_t drowsy_at;
    if (s_sleeping) return;
    if (s_view != VIEW_FACE || s_demo || s_override < FACE__COUNT) {
        touch(now);
        return;
    }
    if (life_playing()) return;
    const uint32_t limit = clock_ok && is_night(wall_ms) ? IDLE_SLEEP_NIGHT_MS : IDLE_SLEEP_MS;
    if (!s_drowsy) {
        if (now - s_last_touch < limit - DROWSY_MS) return;
        s_drowsy = true;
        drowsy_at = now;
        life_say("que sono...", 3000, now);
    } else if (now - drowsy_at >= DROWSY_MS) {
        life_stop();
        set_sleeping(true, now);
    }
}

static void ui_task(void *arg)
{
    gfx_init();
    face_init();
    s_next_joy = (uint32_t)(esp_timer_get_time() / 1000) + 30000;
    life_init((uint32_t)(esp_timer_get_time() / 1000));
    s_last_touch = (uint32_t)(esp_timer_get_time() / 1000);

    TickType_t last_wake = xTaskGetTickCount();
    for (;;) {
        const uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
        const bool clock_ok = net_time_valid();
        const int64_t wall = net_epoch_ms();

        app_snapshot(&s_snap);
        track_agenda(now);
        check_events(now);
        poll_buttons(now);
        expire(now);
        auto_sleep(now, wall, clock_ok);
        /* Atualizando o firmware: nada mais importa até reiniciar (ou desistir). */
        const bool updating = s_snap.ota.active;
        if (updating && s_sleeping) set_sleeping(false, now);
        /* Tocando música na tela do rosto vira o modo música (curtindo). */
        const bool music_on = !updating && s_snap.music.playing && !s_sleeping && s_view == VIEW_FACE;
        if (updating) {
            life_stop();
            face_set(FACE_THINKING);
        } else if (s_sleeping) {
            life_stop();
            face_set(FACE_SLEEPING);
        } else if (music_on) {
            life_stop();
            face_set(FACE_JAMMING);
        } else {
            face_set(live_mood(now, wall, clock_ok));
        }
        report_face();

        const bool dim = clock_ok && is_night(wall) && s_view != VIEW_ALERT && !updating;
        gfx_set_brightness(updating ? 255 : s_sleeping ? SLEEP_BRIGHTNESS : dim ? NIGHT_BRIGHTNESS : 255);
        gfx_clear(C_BG);
        if (updating) {
            render_ota_view(now);
        } else if (s_sleeping) {
            render_sleep_view(now, wall, clock_ok);
        } else if (music_on) {
            render_music_view(now, wall, clock_ok);
        } else {
            switch (s_view) {
            case VIEW_FACE: render_face_view(now, wall, clock_ok); break;
            case VIEW_ALERT: render_alert_view(now, wall, clock_ok); break;
            case VIEW_AGENDA: render_agenda_view(wall, clock_ok); break;
            case VIEW_CLAUDE: render_claude_view(wall, clock_ok); break;
            }
        }
        hal_display_blit(gfx_fb(), 0, 0, GFX_W, GFX_H);

        vTaskDelayUntil(&last_wake, pdMS_TO_TICKS(s_sleeping ? SLEEP_FRAME_MS : FRAME_MS));
    }
}

void ui_start(void)
{
    xTaskCreate(ui_task, "ui", 6144, NULL, 5, NULL);
}
