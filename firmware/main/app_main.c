#include "app_state.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "hal.h"
#include "net.h"
#include "ota.h"
#include "presence.h"
#include "ui.h"
#include "ws_client.h"

static const char *TAG = "robo";

void app_main(void)
{
    ESP_LOGI(TAG, "robo fw %s em %s", esp_app_get_description()->version, hal_caps()->chip_name);

    app_state_init();
    ota_init(); /* veio de uma atualização? a imagem só é confirmada quando o servidor responder */
    ESP_ERROR_CHECK(hal_display_init());
    ESP_ERROR_CHECK(hal_buttons_init());
    ui_start(); /* o rosto aparece antes da rede subir */

    net_start();
    ws_client_start();
    presence_start(); /* experimento: o sinal do iPhone diz se o dono está na mesa? */
}
