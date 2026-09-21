#include "ota.h"

#include <string.h>
#include <strings.h>
#include "app_state.h"
#include "esp_app_desc.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "protocol.h"
#include "ws_client.h"

static const char *TAG = "ota";

#define CHUNK 4096
/* Erro na mesma versão: espera antes de tentar de novo (cada reconexão traz a oferta de volta). */
#define RETRY_COOLDOWN_US (30 * 60 * 1000000LL)
/* Imagem nova que não fala com o servidor neste tempo volta para a anterior. */
#define PROVE_TIMEOUT_US  (5 * 60 * 1000000LL)
/* Antes de reiniciar: tempo para a tela mostrar "pronto" e o status subir pelo WebSocket. */
#define REBOOT_DELAY_MS   1500

typedef struct {
    char version[ROBO_OTA_VERSION_MAX_BYTES + 1];
    char url[ROBO_OTA_URL_MAX_BYTES + 1];
    char sha256[ROBO_OTA_SHA256_BYTES + 1];
    int size;
} job_t;

static job_t s_job;
static volatile bool s_busy;
static bool s_pending_verify;            /* imagem em teste, esperando o servidor responder */
static esp_timer_handle_t s_prove_timer; /* se ele não responder, desfaz a atualização */
static char s_failed[ROBO_OTA_VERSION_MAX_BYTES + 1];
static int64_t s_failed_at;
static uint8_t s_buf[CHUNK];

bool ota_busy(void)
{
    return s_busy;
}

/* Conta para a tela e para o servidor em que pé está a atualização. */
static void report(robo_ota_phase_t phase, int pct, const char *detail)
{
    ota_state_t st = {.active = true, .phase = phase, .pct = pct};
    strlcpy(st.version, s_job.version, sizeof(st.version));
    app_set_ota(&st);
    ws_client_send_ota_status(phase, pct, s_job.version, detail);
}

/* Tira a tela de atualização: o robô volta a ser robô. */
static void clear_screen_state(void)
{
    const ota_state_t off = {0};
    app_set_ota(&off);
}

static void fail(const char *detail)
{
    ESP_LOGE(TAG, "falhou: %s", detail);
    strlcpy(s_failed, s_job.version, sizeof(s_failed));
    s_failed_at = esp_timer_get_time();
    report(ROBO_OTA_ERROR, 0, detail);
    vTaskDelay(pdMS_TO_TICKS(4000)); /* deixa o aviso na tela antes de voltar ao rosto */
    clear_screen_state();
    s_busy = false;
}

static void hex32(const uint8_t *digest, char *out)
{
    static const char *H = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out[i * 2] = H[digest[i] >> 4];
        out[i * 2 + 1] = H[digest[i] & 0xF];
    }
    out[64] = '\0';
}

static void ota_task(void *arg)
{
    ESP_LOGI(TAG, "atualizando para %s (%d bytes)", s_job.version, s_job.size);
    report(ROBO_OTA_START, 0, NULL);

    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (!target) {
        fail("sem partição livre");
        vTaskDelete(NULL);
        return;
    }

    const esp_http_client_config_t http = {
        .url = s_job.url,
        .crt_bundle_attach = esp_crt_bundle_attach, /* https: mesmo bundle do WebSocket */
        .timeout_ms = 15000,
        .keep_alive_enable = true,
        .buffer_size = 2048,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http);
    if (!client) {
        fail("sem memória para baixar");
        vTaskDelete(NULL);
        return;
    }

    esp_ota_handle_t writer = 0;
    bool writing = false;
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    const char *problem = NULL;

    do {
        if (esp_http_client_open(client, 0) != ESP_OK) {
            problem = "não consegui abrir o download";
            break;
        }
        const int64_t len = esp_http_client_fetch_headers(client);
        const int status = esp_http_client_get_status_code(client);
        if (status != 200) {
            problem = "o servidor recusou o download";
            ESP_LOGE(TAG, "HTTP %d em %s", status, s_job.url);
            break;
        }
        const int total = len > 0 ? (int)len : s_job.size;

        if (esp_ota_begin(target, total, &writer) != ESP_OK) {
            problem = "não consegui preparar a partição";
            break;
        }
        writing = true;
        mbedtls_sha256_starts(&sha, 0);
        report(ROBO_OTA_DOWNLOAD, 0, NULL);

        int got = 0;
        int shown = -1;
        for (;;) {
            const int n = esp_http_client_read(client, (char *)s_buf, CHUNK);
            if (n < 0) {
                problem = "a conexão caiu no meio";
                break;
            }
            if (n == 0) break; /* fim */
            if (esp_ota_write(writer, s_buf, n) != ESP_OK) {
                problem = "erro ao gravar na flash";
                break;
            }
            mbedtls_sha256_update(&sha, s_buf, n);
            got += n;
            const int pct = total > 0 ? (int)((int64_t)got * 100 / total) : 0;
            if (pct / 5 != shown) { /* de 5 em 5%: tela e servidor não precisam de mais */
                shown = pct / 5;
                report(ROBO_OTA_DOWNLOAD, pct, NULL);
            }
        }
        if (problem) break;
        if (got < total) {
            problem = "download incompleto";
            break;
        }

        report(ROBO_OTA_VERIFY, 100, NULL);
        uint8_t digest[32];
        char hex[65];
        mbedtls_sha256_finish(&sha, digest);
        hex32(digest, hex);
        if (strcasecmp(hex, s_job.sha256) != 0) {
            ESP_LOGE(TAG, "sha256 esperado %s, veio %s", s_job.sha256, hex);
            problem = "o arquivo chegou corrompido";
            break;
        }
        if (esp_ota_end(writer) != ESP_OK) {
            writing = false; /* o esp_ota_end já soltou o handle */
            problem = "a imagem baixada não é válida";
            break;
        }
        writing = false;
        if (esp_ota_set_boot_partition(target) != ESP_OK) {
            problem = "não consegui apontar para a versão nova";
            break;
        }
    } while (0);

    mbedtls_sha256_free(&sha);
    if (writing) esp_ota_abort(writer);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (problem) {
        fail(problem);
        vTaskDelete(NULL);
        return;
    }

    ESP_LOGI(TAG, "%s gravado e conferido — reiniciando", s_job.version);
    report(ROBO_OTA_DONE, 100, NULL);
    vTaskDelay(pdMS_TO_TICKS(REBOOT_DELAY_MS));
    esp_restart();
}

void ota_offer(const char *version, const char *url, const char *sha256, int size)
{
    if (!version || !url || !sha256 || size <= 0) return;
    if (s_busy) return;
    if (strcmp(version, esp_app_get_description()->version) == 0) return; /* já é esta */
    if (s_failed[0] && strcmp(version, s_failed) == 0 && esp_timer_get_time() - s_failed_at < RETRY_COOLDOWN_US) {
        ESP_LOGW(TAG, "%s falhou há pouco — espero antes de tentar de novo", version);
        return;
    }
    if (strlen(url) > ROBO_OTA_URL_MAX_BYTES || strlen(sha256) != ROBO_OTA_SHA256_BYTES) {
        ESP_LOGW(TAG, "oferta malformada, ignorada");
        return;
    }

    s_busy = true;
    strlcpy(s_job.version, version, sizeof(s_job.version));
    strlcpy(s_job.url, url, sizeof(s_job.url));
    strlcpy(s_job.sha256, sha256, sizeof(s_job.sha256));
    s_job.size = size;

    if (xTaskCreate(ota_task, "ota", 10240, NULL, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "sem memória para a task de atualização");
        s_busy = false;
    }
}

/* A imagem nova subiu mas nunca falou com o servidor: melhor voltar para a que funcionava. */
static void prove_timeout(void *arg)
{
    if (!s_pending_verify) return;
    ESP_LOGE(TAG, "a versão nova não falou com o servidor — voltando para a anterior");
    esp_ota_mark_app_invalid_rollback_and_reboot();
}

void ota_init(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) != ESP_OK || state != ESP_OTA_IMG_PENDING_VERIFY) return;

    s_pending_verify = true;
    ESP_LOGW(TAG, "versão %s em teste — confirmo quando o servidor responder", esp_app_get_description()->version);
    const esp_timer_create_args_t args = {.callback = prove_timeout, .name = "ota_prove"};
    if (esp_timer_create(&args, &s_prove_timer) == ESP_OK) esp_timer_start_once(s_prove_timer, PROVE_TIMEOUT_US);
}

void ota_confirm_running(void)
{
    if (!s_pending_verify) return;
    s_pending_verify = false;
    if (s_prove_timer) esp_timer_stop(s_prove_timer);
    if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
        ESP_LOGI(TAG, "versão %s confirmada", esp_app_get_description()->version);
    }
}
