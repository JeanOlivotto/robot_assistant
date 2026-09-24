#include "presence.h"

#include <stdio.h>
#include <string.h>
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "net.h"
#include "protocol.h"
#include "ws_client.h"

/*
 * Experimento: dá para saber se o dono está na mesa pelo sinal do iPhone dele? O iPhone troca o
 * endereço Bluetooth a cada ~15 min e não diz de quem é, então aqui só se mede — quem interpreta
 * (mais forte que X = alguém perto) é o servidor, olhando o histórico.
 */

#define REPORT_MS   10000
#define MAX_SEEN    16  /* aparelhos distintos guardados por janela */
#define MAX_REPORT  8   /* quantos vão na mensagem: os de sinal mais forte */
#define APPLE_ID    0x004C

/* Varredura passiva em fatias: 50 ms ouvindo a cada 160 ms (unidades de 0,625 ms). O rádio é
 * um só para Wi-Fi e Bluetooth. Com 30/320 ms (9%) o iPhone bloqueado, que anuncia pouco,
 * sumia por minutos com o dono na mesa; o Wi-Fi do robô quase não tem tráfego e aguenta 31%. */
#define SCAN_ITVL   256
#define SCAN_WINDOW 80

#define NEAR_RSSI   (-60)
#define NEAR_MS     (5 * 60 * 1000)
#define NEARBY_INFO 0x10

typedef struct {
    uint8_t addr[6];
    int8_t rssi;  /* o mais forte da janela */
    uint8_t kind; /* tipo do anúncio Apple (0x10 = Nearby Info: iPhone/iPad/Mac ativo) */
} seen_t;

static const char *TAG = "ble";
static seen_t s_seen[MAX_SEEN];
static int s_n;
static int s_total; /* anúncios Apple ouvidos na janela, repetidos inclusive */
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static uint8_t s_own_addr_type;
static volatile bool s_running;
static volatile int64_t s_strong_at_us; /* última vez que um iPhone apareceu forte */

static void scan(void);

/* O primeiro tipo Apple no manufacturer data (0xFF) do anúncio, ou -1 se não for da Apple. */
static int apple_kind(const uint8_t *d, uint8_t len)
{
    for (int i = 0; i + 1 < len;) {
        const uint8_t l = d[i];
        if (l == 0 || i + 1 + l > len) break;
        if (d[i + 1] == 0xFF && l >= 4) {
            const uint16_t company = d[i + 2] | (d[i + 3] << 8);
            if (company == APPLE_ID) return l >= 5 ? d[i + 4] : 0;
        }
        i += 1 + l;
    }
    return -1;
}

static void note(const uint8_t addr[6], int8_t rssi, uint8_t kind)
{
    if (kind == NEARBY_INFO && rssi >= NEAR_RSSI) s_strong_at_us = esp_timer_get_time();
    portENTER_CRITICAL(&s_lock);
    s_total++;
    for (int i = 0; i < s_n; i++) {
        if (memcmp(s_seen[i].addr, addr, 6) == 0) {
            if (rssi > s_seen[i].rssi) s_seen[i].rssi = rssi;
            s_seen[i].kind = kind;
            portEXIT_CRITICAL(&s_lock);
            return;
        }
    }
    int slot = s_n < MAX_SEEN ? s_n++ : -1;
    if (slot < 0) { /* cheio: troca o mais fraco, se este for mais forte */
        slot = 0;
        for (int i = 1; i < MAX_SEEN; i++)
            if (s_seen[i].rssi < s_seen[slot].rssi) slot = i;
        if (s_seen[slot].rssi >= rssi) slot = -1;
    }
    if (slot >= 0) {
        memcpy(s_seen[slot].addr, addr, 6);
        s_seen[slot].rssi = rssi;
        s_seen[slot].kind = kind;
    }
    portEXIT_CRITICAL(&s_lock);
}

static int on_gap(struct ble_gap_event *ev, void *arg)
{
    switch (ev->type) {
    case BLE_GAP_EVENT_DISC: {
        const int kind = apple_kind(ev->disc.data, ev->disc.length_data);
        if (kind >= 0) note(ev->disc.addr.val, ev->disc.rssi, (uint8_t)kind);
        return 0;
    }
    case BLE_GAP_EVENT_DISC_COMPLETE:
        scan(); /* não devia acabar (duração infinita), mas se acabar, recomeça */
        return 0;
    default:
        return 0;
    }
}

static void scan(void)
{
    const struct ble_gap_disc_params p = {
        .itvl = SCAN_ITVL,
        .window = SCAN_WINDOW,
        .passive = 1,           /* só ouve: não pede scan response a ninguém */
        .filter_duplicates = 0, /* queremos cada anúncio, é ele que traz o RSSI */
    };
    const int rc = ble_gap_disc(s_own_addr_type, BLE_HS_FOREVER, &p, on_gap, NULL);
    if (rc != 0) ESP_LOGW(TAG, "não consegui começar a varredura (rc=%d)", rc);
}

static void on_sync(void)
{
    if (ble_hs_id_infer_auto(0, &s_own_addr_type) != 0) s_own_addr_type = BLE_OWN_ADDR_PUBLIC;
    scan();
    ESP_LOGI(TAG, "ouvindo o Bluetooth (heap livre %lu)", (unsigned long)esp_get_free_heap_size());
}

static void host_task(void *arg)
{
    nimble_port_run(); /* só volta quando o NimBLE para */
    nimble_port_freertos_deinit();
}

/* Manda os mais fortes da janela e zera para a próxima. */
static void report_task(void *arg)
{
    static seen_t snap[MAX_SEEN];
    static char buf[96 + MAX_REPORT * 40];
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(REPORT_MS));
        if (!s_running) continue;

        portENTER_CRITICAL(&s_lock);
        const int n = s_n;
        const int total = s_total;
        memcpy(snap, s_seen, sizeof(seen_t) * n);
        s_n = 0;
        s_total = 0;
        portEXIT_CRITICAL(&s_lock);

        /* ordena por sinal, mais forte primeiro (n ≤ 16: inserção basta) */
        for (int i = 1; i < n; i++) {
            const seen_t x = snap[i];
            int j = i - 1;
            while (j >= 0 && snap[j].rssi < x.rssi) {
                snap[j + 1] = snap[j];
                j--;
            }
            snap[j + 1] = x;
        }

        int len = snprintf(buf, sizeof(buf), "{\"t\":\"" ROBO_MSG_BLE "\",\"ts\":%lld,\"n\":%d,\"ads\":%d,\"dev\":[",
                           (long long)net_epoch_ms(), n, total);
        for (int i = 0; i < n && i < MAX_REPORT; i++) {
            /* NimBLE guarda o endereço invertido: val[5] é o byte mais significativo. */
            const uint8_t *a = snap[i].addr;
            len += snprintf(buf + len, sizeof(buf) - len, "%s{\"a\":\"%02x%02x%02x\",\"r\":%d,\"k\":%u}", i ? "," : "",
                            a[2], a[1], a[0], snap[i].rssi, snap[i].kind);
        }
        snprintf(buf + len, sizeof(buf) - len, "]}");
        ws_client_send_json(buf);
    }
}

void presence_start(void)
{
    static bool reporting;
    if (s_running) return;
    const esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Bluetooth não subiu (%s) — segue sem presença", esp_err_to_name(err));
        return;
    }
    ble_hs_cfg.sync_cb = on_sync;
    nimble_port_freertos_init(host_task);
    s_running = true;
    if (!reporting) reporting = xTaskCreate(report_task, "ble_report", 3072, NULL, 2, NULL) == pdPASS;
}

bool presence_listening(void)
{
    return s_running;
}

bool presence_near(void)
{
    return s_running && s_strong_at_us && esp_timer_get_time() - s_strong_at_us < (int64_t)NEAR_MS * 1000;
}

void presence_stop(void)
{
    if (!s_running) return;
    s_running = false;
    ble_gap_disc_cancel();
    if (nimble_port_stop() == 0) nimble_port_deinit();
    portENTER_CRITICAL(&s_lock);
    s_n = 0;
    s_total = 0;
    portEXIT_CRITICAL(&s_lock);
    ESP_LOGI(TAG, "Bluetooth desligado (heap livre %lu)", (unsigned long)esp_get_free_heap_size());
}
