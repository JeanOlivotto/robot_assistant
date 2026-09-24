#include "ws_client.h"

#include <stdio.h>
#include <string.h>
#include "app_state.h"
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal.h"
#include "face.h"
#include "net.h"
#include "ota.h"
#include "secrets.h"

/* Servidor: ROBO_SERVER_URL ("wss://host" ou "ws://ip:porta"); o formato antigo HOST/PORT ainda vale. */
#define STR_(x) #x
#define STR(x)  STR_(x)
#ifdef ROBO_SERVER_URL
#define SERVER_BASE ROBO_SERVER_URL
#else
#define SERVER_BASE "ws://" ROBO_SERVER_HOST ":" STR(ROBO_SERVER_PORT)
#endif

#define PING_PERIOD_MS 15000 /* seção 7.1 */
#define RX_MAX         4096
#define SEND_TIMEOUT   pdMS_TO_TICKS(200)

static const char *TAG = "ws";

static esp_websocket_client_handle_t s_client;
static bool s_started;
static int s_last_errno = -1;
static char s_rx[RX_MAX + 1];
static size_t s_rx_len;
static bool s_rx_overflow;

void ws_client_send_json(const char *json)
{
    if (!esp_websocket_client_is_connected(s_client)) return;
    if (esp_websocket_client_send_text(s_client, json, strlen(json), SEND_TIMEOUT) < 0) {
        ESP_LOGW(TAG, "falha ao enviar: %s", json);
    }
}

static void send_hello(void)
{
    const hal_caps_t *caps = hal_caps();
    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"t\":\"" ROBO_MSG_HELLO "\",\"ts\":%lld,\"dev\":\"%s\",\"fw\":\"%s\",\"chip\":\"%s\","
             "\"caps\":{\"codec\":[],\"wake\":\"none\",\"lcd\":{\"w\":%u,\"h\":%u}}}",
             (long long)net_epoch_ms(), ROBO_DEVICE_NAME, esp_app_get_description()->version, caps->chip_name,
             caps->lcd_w, caps->lcd_h);
    ws_client_send_json(buf);
}

void ws_client_send_face(robo_face_t face)
{
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"t\":\"" ROBO_MSG_FACE "\",\"ts\":%lld,\"v\":\"%s\"}", (long long)net_epoch_ms(),
             robo_face_name(face));
    ws_client_send_json(buf);
}

void ws_client_send_ota_status(robo_ota_phase_t phase, int pct, const char *version, const char *detail)
{
    char buf[256];
    char extra[160] = "";
    if (detail && detail[0]) snprintf(extra, sizeof(extra), ",\"detail\":\"%.100s\"", detail);
    snprintf(buf, sizeof(buf), "{\"t\":\"" ROBO_MSG_OTA_STATUS "\",\"ts\":%lld,\"phase\":\"%s\",\"pct\":%d,\"version\":\"%.31s\"%s}",
             (long long)net_epoch_ms(), robo_ota_phase_name(phase), pct < 0 ? 0 : pct > 100 ? 100 : pct,
             version ? version : "", extra);
    ws_client_send_json(buf);
}

void ws_client_send_button(robo_btn_t id, robo_btn_ev_t ev)
{
    char buf[96];
    snprintf(buf, sizeof(buf), "{\"t\":\"" ROBO_MSG_BUTTON "\",\"ts\":%lld,\"id\":\"%s\",\"ev\":\"%s\"}",
             (long long)net_epoch_ms(), robo_btn_name(id), robo_btn_ev_name(ev));
    ws_client_send_json(buf);
}

static const char *str_or(const cJSON *obj, const char *key, const char *fallback)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(v) ? v->valuestring : fallback;
}

static int64_t num_or(const cJSON *obj, const char *key, int64_t fallback)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsNumber(v) ? (int64_t)v->valuedouble : fallback;
}

static void on_agenda(const cJSON *msg)
{
    static agenda_item_t items[ROBO_AGENDA_MAX_ITEMS]; /* static: 1 KB fora da pilha */
    int n = 0;
    const cJSON *it;
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(msg, "items"))
    {
        if (n == ROBO_AGENDA_MAX_ITEMS) break;
        agenda_item_t *a = &items[n++];
        strlcpy(a->id, str_or(it, "id", ""), sizeof(a->id));
        strlcpy(a->title, str_or(it, "title", ""), sizeof(a->title));
        a->start_ms = num_or(it, "start", 0);
        a->end_ms = num_or(it, "end", 0);
        a->all_day = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(it, "all_day"));
    }
    app_set_agenda(items, n);
    ESP_LOGI(TAG, "agenda: %d compromisso(s)", n);
}

static void on_display(const cJSON *msg)
{
    alert_t a = {0};
    strlcpy(a.id, str_or(msg, "id", ""), sizeof(a.id));
    strlcpy(a.title, str_or(msg, "title", ""), sizeof(a.title));
    strlcpy(a.sub, str_or(msg, "sub", ""), sizeof(a.sub));
    a.at_ms = num_or(msg, "at", 0);
    a.ttl_ms = (uint32_t)num_or(msg, "ttl_ms", 30000);
    app_push_alert(&a);
    ESP_LOGI(TAG, "alerta: %s (%s)", a.title, a.sub);
}

static void on_chat(const cJSON *msg)
{
    chat_state_t c = {0};
    c.thinking = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(msg, "thinking"));
    c.waiting_since_ms = num_or(msg, "waiting_since", 0);
    strlcpy(c.preview, str_or(msg, "preview", ""), sizeof(c.preview));
    app_set_chat(&c);
}

static void on_react(const cJSON *msg)
{
    const int face = robo_face_from_name(str_or(msg, "v", ""));
    if (face >= 0) app_push_react((robo_face_t)face, (uint32_t)num_or(msg, "ms", 3000));
}

static void on_music(const cJSON *msg)
{
    music_state_t m = {0};
    m.playing = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(msg, "playing"));
    strlcpy(m.title, str_or(msg, "title", ""), sizeof(m.title));
    strlcpy(m.artist, str_or(msg, "artist", ""), sizeof(m.artist));
    app_set_music(&m);
}

static void handle_message(const char *json, size_t len)
{
    cJSON *msg = cJSON_ParseWithLength(json, len);
    if (!msg) {
        ESP_LOGW(TAG, "JSON inválido do servidor");
        return;
    }
    const char *t = str_or(msg, "t", "");
    net_time_hint(num_or(msg, "ts", 0));

    if (strcmp(t, ROBO_MSG_HELLO_ACK) == 0) {
        net_set_tz(str_or(msg, "tz_posix", NULL));
        app_set_server(true);
        /* O servidor respondeu: se esta imagem acabou de ser instalada, ela presta. */
        ota_confirm_running();
        ESP_LOGI(TAG, "sessão aberta (%s)", str_or(msg, "tz", "?"));
    } else if (strcmp(t, ROBO_MSG_AGENDA) == 0) {
        on_agenda(msg);
    } else if (strcmp(t, ROBO_MSG_DISPLAY) == 0) {
        on_display(msg);
    } else if (strcmp(t, ROBO_MSG_CHAT) == 0) {
        on_chat(msg);
    } else if (strcmp(t, ROBO_MSG_REACT) == 0) {
        on_react(msg);
    } else if (strcmp(t, ROBO_MSG_SAY) == 0) {
        app_push_say(str_or(msg, "text", ""), (uint32_t)num_or(msg, "ms", 5000));
    } else if (strcmp(t, ROBO_MSG_MUSIC) == 0) {
        on_music(msg);
    } else if (strcmp(t, ROBO_MSG_MODE) == 0) {
        const bool hacker = robo_mode_from_name(str_or(msg, "v", "")) == ROBO_MODE_HACKER;
        face_set_hacker(hacker);
        ESP_LOGI(TAG, "modo %s (pelo servidor)", hacker ? "hacker" : "normal");
    } else if (strcmp(t, ROBO_MSG_OTA) == 0) {
        ota_offer(str_or(msg, "version", ""), str_or(msg, "url", ""), str_or(msg, "sha256", ""),
                  (int)num_or(msg, "size", 0));
    } else if (strcmp(t, ROBO_MSG_PONG) == 0 || strcmp(t, ROBO_MSG_STATE) == 0) {
        /* pong: só serve de tráfego; state: o rosto ainda é decidido localmente */
    } else {
        ESP_LOGW(TAG, "mensagem desconhecida: %s", t);
    }
    cJSON_Delete(msg);
}

static void on_ws_event(void *arg, esp_event_base_t base, int32_t id, void *event_data)
{
    const esp_websocket_event_data_t *d = event_data;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "conectado em %s (heap livre %lu)", SERVER_BASE, (unsigned long)esp_get_free_heap_size());
        s_last_errno = 0;
        net_set_server_ok(true);
        send_hello();
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        if (s_last_errno == 0) ESP_LOGW(TAG, "desconectado do servidor");
        app_set_server(false);
        net_set_server_ok(false);
        break;
    case WEBSOCKET_EVENT_DATA:
        if (d->op_code != 0x1 && d->op_code != 0x0) break; /* só texto (e continuação) */
        /* Mensagem maior que o buffer do cliente chega em pedaços: remonta pelo offset. */
        if (d->payload_offset == 0) {
            s_rx_len = 0;
            s_rx_overflow = false;
        }
        if (d->payload_offset + d->data_len > RX_MAX) {
            s_rx_overflow = true;
        } else {
            memcpy(s_rx + d->payload_offset, d->data_ptr, d->data_len);
            s_rx_len = d->payload_offset + d->data_len;
        }
        if (d->payload_offset + d->data_len >= d->payload_len) {
            if (s_rx_overflow) ESP_LOGW(TAG, "mensagem de %d bytes descartada (limite %d)", d->payload_len, RX_MAX);
            else handle_message(s_rx, s_rx_len);
        }
        break;
    case WEBSOCKET_EVENT_ERROR: {
        const int err = d->error_handle.esp_transport_sock_errno;
        if (err != s_last_errno) ESP_LOGW(TAG, "sem conexão com %s (errno %d)", SERVER_BASE, err);
        s_last_errno = err;
        break;
    }
    default:
        break;
    }
}

static void send_battery(void)
{
    const hal_power_t p = hal_power_read();
    char buf[96];
    snprintf(buf, sizeof(buf), "{\"t\":\"" ROBO_MSG_BATTERY "\",\"ts\":%lld,\"mv\":%d,\"usb\":%s}",
             (long long)net_epoch_ms(), p.mv, p.usb ? "true" : "false");
    ws_client_send_json(buf);
}

static void ping_task(void *arg)
{
    for (unsigned n = 0;; n++) {
        vTaskDelay(pdMS_TO_TICKS(PING_PERIOD_MS));
        char buf[48];
        snprintf(buf, sizeof(buf), "{\"t\":\"" ROBO_MSG_PING "\",\"ts\":%lld}", (long long)net_epoch_ms());
        ws_client_send_json(buf);
        if (n % 4 == 0) send_battery(); /* a cada minuto */
    }
}

/* Só começa a conectar quando o Wi-Fi tem IP; depois o próprio cliente reconecta sozinho. */
static void on_got_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (s_started) return;
    s_started = true;
    ESP_ERROR_CHECK(esp_websocket_client_start(s_client));
}

void ws_client_start(void)
{
    static char uri[192];
    snprintf(uri, sizeof(uri), "%s/device?token=%s", SERVER_BASE, ROBO_DEVICE_TOKEN);

    /* O cliente loga cada tentativa como erro; o resumo sai por on_ws_event. */
    esp_log_level_set("transport_base", ESP_LOG_NONE);
    esp_log_level_set("transport_ws", ESP_LOG_NONE);
    esp_log_level_set("esp-tls", ESP_LOG_NONE);
    esp_log_level_set("websocket_client", ESP_LOG_WARN);

    const esp_websocket_client_config_t cfg = {
        .uri = uri,
        .buffer_size = 2048,
        .task_stack = 6144,
        .reconnect_timeout_ms = 3000,
        /* Sem isto, um fechamento limpo pelo servidor (todo deploy) para o cliente de vez. */
        .enable_close_reconnect = true,
        .network_timeout_ms = 10000,
        .crt_bundle_attach = esp_crt_bundle_attach, /* wss: valida o certificado (Let's Encrypt) */
    };
    s_client = esp_websocket_client_init(&cfg);
    ESP_ERROR_CHECK(esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, on_ws_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_got_ip, NULL));
    xTaskCreate(ping_task, "ws_ping", 3072, NULL, 3, NULL);
}
