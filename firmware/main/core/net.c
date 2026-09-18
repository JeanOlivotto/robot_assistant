#include "net.h"

#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include "app_state.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "secrets.h"

#define DEFAULT_TZ "<-03>3" /* America/Sao_Paulo, sem horário de verão desde 2019 */

#define RETRIES_PER_NET       3                 /* falhas seguidas antes de trocar de rede */
#define BAD_NET_MS            (5 * 60 * 1000)   /* rede que falhou fica de castigo */
#define SERVER_DOWN_SWITCH_MS (2 * 60 * 1000)   /* Wi-Fi ok mas servidor inalcançável: tenta outra */
#define MIN_RSSI              (-88)

typedef struct {
    const char *ssid;
    const char *pass;
} wifi_net_t;

/* Lista em ordem de prioridade (secrets.h). Aceita o formato antigo de rede única. */
#ifdef ROBO_WIFI_NETWORKS
static const wifi_net_t s_nets[] = {ROBO_WIFI_NETWORKS};
#else
static const wifi_net_t s_nets[] = {{ROBO_WIFI_SSID, ROBO_WIFI_PASS}};
#endif
#define N_NETS ((int)(sizeof(s_nets) / sizeof(s_nets[0])))

typedef enum { STEP_SCAN, STEP_CONNECT } step_t;

static const char *TAG = "net";
/* Backoff da seção 4.1: 1, 2, 4, 8 s e teto de 30 s. */
static const uint32_t s_backoff_ms[] = {1000, 2000, 4000, 8000, 30000};

static esp_timer_handle_t s_step_timer, s_watchdog;
static step_t s_next_step;
static int s_cur;        /* rede em uso (ou tentando) */
static int s_fails;      /* falhas seguidas nela */
static int s_scan_round; /* buscas seguidas sem achar rede conhecida */
static int s_switches;   /* trocas por falta de servidor desde o último sucesso */
static int64_t s_bad_until[N_NETS];
static volatile bool s_connected, s_switching, s_server_ok;
static volatile int64_t s_server_down_since;
static volatile bool s_time_synced;
static bool s_sntp_started;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static uint32_t backoff(int n)
{
    const int max = sizeof(s_backoff_ms) / sizeof(s_backoff_ms[0]) - 1;
    return s_backoff_ms[n < 0 ? 0 : n > max ? max : n];
}

static void schedule(step_t step, uint32_t delay_ms)
{
    s_next_step = step;
    esp_timer_stop(s_step_timer);
    esp_timer_start_once(s_step_timer, (uint64_t)delay_ms * 1000 + 1);
}

static void start_scan(void)
{
    const wifi_scan_config_t sc = {.show_hidden = true};
    if (esp_wifi_scan_start(&sc, false) != ESP_OK) schedule(STEP_SCAN, 2000);
}

static void connect_to(int i)
{
    wifi_config_t cfg = {0};
    strlcpy((char *)cfg.sta.ssid, s_nets[i].ssid, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, s_nets[i].pass, sizeof(cfg.sta.password));
    cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    cfg.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL; /* rede com vários roteadores: pega o mais forte */
    cfg.sta.pmf_cfg.capable = true;
    s_cur = i;
    ESP_LOGI(TAG, "conectando em \"%s\" (rede %d de %d)...", s_nets[i].ssid, i + 1, N_NETS);
    esp_wifi_set_config(WIFI_IF_STA, &cfg);
    esp_wifi_connect();
}

/* A primeira da lista que está no ar e fora do castigo; se todas estão de castigo, a primeira no ar. */
static int pick_network(void)
{
    static wifi_ap_record_t recs[20]; /* estático: não cabe na pilha da tarefa de eventos */
    uint16_t n = sizeof(recs) / sizeof(recs[0]);
    if (esp_wifi_scan_get_ap_records(&n, recs) != ESP_OK) n = 0;

    const int64_t now = now_ms();
    int fallback = -1;
    for (int i = 0; i < N_NETS; i++) {
        bool seen = false;
        for (int k = 0; k < n && !seen; k++) {
            seen = strcmp((const char *)recs[k].ssid, s_nets[i].ssid) == 0 && recs[k].rssi >= MIN_RSSI;
        }
        if (!seen) continue;
        if (now >= s_bad_until[i]) return i;
        if (fallback < 0) fallback = i;
    }
    return fallback;
}

static void step(void *arg)
{
    if (s_next_step == STEP_SCAN) start_scan();
    else connect_to(s_cur);
}

/* Wi-Fi conectado, mas o servidor não responde há um tempo: provavelmente sem internet. */
static void watchdog(void *arg)
{
    if (!s_connected || s_server_ok || N_NETS < 2 || s_switches >= N_NETS) return;
    if (now_ms() - s_server_down_since < SERVER_DOWN_SWITCH_MS) return;
    ESP_LOGW(TAG, "\"%s\" sem acesso ao servidor há %d min — tentando outra rede", s_nets[s_cur].ssid,
             SERVER_DOWN_SWITCH_MS / 60000);
    s_bad_until[s_cur] = now_ms() + BAD_NET_MS;
    s_switches++;
    s_switching = true;
    esp_wifi_disconnect();
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (id == WIFI_EVENT_STA_START) {
        start_scan();
    } else if (id == WIFI_EVENT_SCAN_DONE) {
        const int i = pick_network();
        if (i < 0) {
            if (N_NETS == 1) { /* pode ser rede oculta: tenta direto */
                connect_to(0);
                return;
            }
            const uint32_t wait = backoff(s_scan_round++);
            ESP_LOGW(TAG, "nenhuma rede conhecida no ar; nova busca em %lu ms", (unsigned long)wait);
            schedule(STEP_SCAN, wait);
            return;
        }
        s_scan_round = 0;
        s_fails = 0;
        connect_to(i);
    } else if (id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *ev = data;
        s_connected = false;
        app_set_wifi(false);
        if (s_switching) {
            s_switching = false;
            start_scan();
            return;
        }
        s_fails++;
        if (s_fails < RETRIES_PER_NET || N_NETS == 1) {
            const uint32_t wait = backoff(s_fails - 1);
            ESP_LOGW(TAG, "\"%s\" caiu (motivo %d), nova tentativa em %lu ms", s_nets[s_cur].ssid, ev->reason,
                     (unsigned long)wait);
            schedule(STEP_CONNECT, wait);
        } else {
            ESP_LOGW(TAG, "\"%s\" falhou %d vezes (motivo %d) — procurando outra rede", s_nets[s_cur].ssid, s_fails,
                     ev->reason);
            s_bad_until[s_cur] = now_ms() + BAD_NET_MS;
            s_fails = 0;
            schedule(STEP_SCAN, 500);
        }
    }
}

static void on_time_sync(struct timeval *tv)
{
    s_time_synced = true;
    ESP_LOGI(TAG, "relógio sincronizado por SNTP");
}

static void on_got_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    const ip_event_got_ip_t *ev = data;
    ESP_LOGI(TAG, "\"%s\" conectada, IP " IPSTR, s_nets[s_cur].ssid, IP2STR(&ev->ip_info.ip));
    s_connected = true;
    s_fails = 0;
    s_server_down_since = now_ms();
    app_set_wifi(true);
    if (!s_sntp_started) {
        esp_netif_sntp_start();
        s_sntp_started = true;
    }
}

void net_start(void)
{
    net_set_tz(DEFAULT_TZ);

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    const esp_timer_create_args_t step_args = {.callback = step, .name = "wifi_step"};
    ESP_ERROR_CHECK(esp_timer_create(&step_args, &s_step_timer));
    const esp_timer_create_args_t wd_args = {.callback = watchdog, .name = "wifi_wd"};
    ESP_ERROR_CHECK(esp_timer_create(&wd_args, &s_watchdog));
    ESP_ERROR_CHECK(esp_timer_start_periodic(s_watchdog, 10 * 1000 * 1000));

    esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    sntp.start = false; /* só depois de ter IP */
    sntp.sync_cb = on_time_sync;
    ESP_ERROR_CHECK(esp_netif_sntp_init(&sntp));

    const wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_got_ip, NULL));

    ESP_LOGI(TAG, "%d rede(s) configurada(s)", N_NETS);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    /* Modo mesa (USB): sem economia de energia no rádio, resposta mais rápida. */
    esp_wifi_set_ps(WIFI_PS_NONE);
}

int net_rssi(void)
{
    wifi_ap_record_t ap;
    if (!s_connected || esp_wifi_sta_get_ap_info(&ap) != ESP_OK) return 0;
    return ap.rssi;
}

void net_set_server_ok(bool ok)
{
    if (ok) s_switches = 0;
    else if (s_server_ok) s_server_down_since = now_ms(); /* conta a partir da queda, não de cada tentativa */
    s_server_ok = ok;
}

void net_set_tz(const char *posix)
{
    if (!posix || !*posix) return;
    setenv("TZ", posix, 1);
    tzset();
}

void net_time_hint(int64_t epoch_ms)
{
    if (s_time_synced || epoch_ms <= 0) return;
    const int64_t diff = epoch_ms - net_epoch_ms();
    if (diff > -2000 && diff < 2000) return;
    const struct timeval tv = {.tv_sec = epoch_ms / 1000, .tv_usec = (epoch_ms % 1000) * 1000};
    settimeofday(&tv, NULL);
    ESP_LOGI(TAG, "relógio ajustado pela hora do servidor");
}

bool net_time_valid(void)
{
    return time(NULL) > 1700000000; /* depois de nov/2023 = já foi acertado */
}

int64_t net_epoch_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}
