/* HAL da SpotPear ESP32-C3 1.44" (ST7735S 128×128). Pinout em firmware/BOARD.md. */
#include "hal.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_lcd_panel_io.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define LCD_HOST      SPI2_HOST
#define PIN_LCD_SCLK  3
#define PIN_LCD_MOSI  4
#define PIN_LCD_RST   5
#define PIN_LCD_DC    0
#define PIN_LCD_CS    2

#define LCD_W         128
#define LCD_H         128
#define LCD_PCLK_HZ   (40 * 1000 * 1000) /* mesmo clock do firmware de fábrica */

/* Painel "GREENTAB3" na rotação 2 do TFT_eSPI (a que o firmware de fábrica usa):
   MADCTL só com BGR, e a área visível começa em (2,1) na RAM de 132×162 do controlador. */
#define LCD_MADCTL    0x08
#define LCD_X_OFFSET  2
#define LCD_Y_OFFSET  1

static const char *TAG = "hal";

static const hal_caps_t s_caps = {
    .chip_name = "esp32c3",
    .has_psram = false,
    .has_local_wakeword = false,
    .supports_opus_encode = false,
    .i2s_controllers = 1,
    .lcd_w = LCD_W,
    .lcd_h = LCD_H,
    .wake_mode = HAL_WAKE_VAD_LOCAL,
};

const hal_caps_t *hal_caps(void)
{
    return &s_caps;
}

/* ── Display ──────────────────────────────────────────────────────────── */

static esp_lcd_panel_io_handle_t s_io;
static SemaphoreHandle_t s_flush_done;

typedef struct {
    uint8_t cmd;
    uint8_t len;
    uint16_t delay_ms;
    uint8_t data[16];
} lcd_cmd_t;

/* Sequência do ST7735R/S (Adafruit "Rcmd1 + Rcmd3"), a mesma do TFT_eSPI para GREENTAB3.
   DISPON fica para depois do primeiro quadro, para não piscar lixo da RAM na tela. */
static const lcd_cmd_t s_init[] = {
    {0x01, 0, 150, {0}},                                  /* SWRESET */
    {0x11, 0, 255, {0}},                                  /* SLPOUT */
    {0xB1, 3, 0, {0x01, 0x2C, 0x2D}},                     /* FRMCTR1 */
    {0xB2, 3, 0, {0x01, 0x2C, 0x2D}},                     /* FRMCTR2 */
    {0xB3, 6, 0, {0x01, 0x2C, 0x2D, 0x01, 0x2C, 0x2D}},   /* FRMCTR3 */
    {0xB4, 1, 0, {0x07}},                                 /* INVCTR */
    {0xC0, 3, 0, {0xA2, 0x02, 0x84}},                     /* PWCTR1 */
    {0xC1, 1, 0, {0xC5}},                                 /* PWCTR2 */
    {0xC2, 2, 0, {0x0A, 0x00}},                           /* PWCTR3 */
    {0xC3, 2, 0, {0x8A, 0x2A}},                           /* PWCTR4 */
    {0xC4, 2, 0, {0x8A, 0xEE}},                           /* PWCTR5 */
    {0xC5, 1, 0, {0x0E}},                                 /* VMCTR1 */
    {0x20, 0, 0, {0}},                                    /* INVOFF */
    {0x36, 1, 0, {LCD_MADCTL}},                           /* MADCTL */
    {0x3A, 1, 0, {0x05}},                                 /* COLMOD: 16 bits/pixel */
    {0xE0, 16, 0, {0x02, 0x1C, 0x07, 0x12, 0x37, 0x32, 0x29, 0x2D,
                   0x29, 0x25, 0x2B, 0x39, 0x00, 0x01, 0x03, 0x10}}, /* GMCTRP1 */
    {0xE1, 16, 0, {0x03, 0x1D, 0x07, 0x06, 0x2E, 0x2C, 0x29, 0x2D,
                   0x2E, 0x2E, 0x37, 0x3F, 0x00, 0x00, 0x02, 0x10}}, /* GMCTRN1 */
    {0x13, 0, 10, {0}},                                   /* NORON */
};

static bool on_color_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *edata, void *ctx)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(s_flush_done, &woken);
    return woken == pdTRUE;
}

esp_err_t hal_display_init(void)
{
    s_flush_done = xSemaphoreCreateBinary();
    ESP_RETURN_ON_FALSE(s_flush_done, ESP_ERR_NO_MEM, TAG, "sem memória para o semáforo");

    const spi_bus_config_t bus = {
        .sclk_io_num = PIN_LCD_SCLK,
        .mosi_io_num = PIN_LCD_MOSI,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = LCD_W * (LCD_H / 2) * sizeof(uint16_t), /* meia tela por transação */
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(LCD_HOST, &bus, SPI_DMA_CH_AUTO), TAG, "spi_bus_initialize");

    const esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num = PIN_LCD_DC,
        .cs_gpio_num = PIN_LCD_CS,
        .pclk_hz = LCD_PCLK_HZ,
        .spi_mode = 0,
        .trans_queue_depth = 8,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .on_color_trans_done = on_color_done,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_cfg, &s_io),
                        TAG, "panel io");

    const gpio_config_t rst = {.pin_bit_mask = 1ULL << PIN_LCD_RST, .mode = GPIO_MODE_OUTPUT};
    ESP_RETURN_ON_ERROR(gpio_config(&rst), TAG, "gpio rst");
    gpio_set_level(PIN_LCD_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(PIN_LCD_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(120));

    for (size_t i = 0; i < sizeof(s_init) / sizeof(s_init[0]); i++) {
        const lcd_cmd_t *c = &s_init[i];
        ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(s_io, c->cmd, c->len ? c->data : NULL, c->len),
                            TAG, "cmd 0x%02x", c->cmd);
        if (c->delay_ms) vTaskDelay(pdMS_TO_TICKS(c->delay_ms));
    }

    /* Quadro preto antes de ligar a tela. Buffer pequeno reaproveitado linha a linha. */
    static uint16_t black_line[LCD_W];
    for (int y = 0; y < LCD_H; y++) hal_display_blit(black_line, 0, y, LCD_W, 1);
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(s_io, 0x29, NULL, 0), TAG, "DISPON");

    ESP_LOGI(TAG, "display ST7735S %dx%d pronto (SPI %d MHz)", LCD_W, LCD_H, LCD_PCLK_HZ / 1000000);
    return ESP_OK;
}

void hal_display_blit(const uint16_t *px, int x, int y, int w, int h)
{
    const int x0 = x + LCD_X_OFFSET, x1 = x + w - 1 + LCD_X_OFFSET;
    const int y0 = y + LCD_Y_OFFSET, y1 = y + h - 1 + LCD_Y_OFFSET;
    esp_lcd_panel_io_tx_param(s_io, 0x2A, (uint8_t[]){x0 >> 8, x0 & 0xFF, x1 >> 8, x1 & 0xFF}, 4); /* CASET */
    esp_lcd_panel_io_tx_param(s_io, 0x2B, (uint8_t[]){y0 >> 8, y0 & 0xFF, y1 >> 8, y1 & 0xFF}, 4); /* RASET */
    esp_lcd_panel_io_tx_color(s_io, 0x2C, px, (size_t)w * h * sizeof(uint16_t));                /* RAMWR */
    xSemaphoreTake(s_flush_done, portMAX_DELAY);
}

void hal_display_backlight(uint8_t pct)
{
    /* Nesta placa o backlight vai direto no 3V3, sem GPIO de controle. */
    (void)pct;
}

/* ── Botões ───────────────────────────────────────────────────────────── */

/* Sem pull-up externo na placa: usa o interno. Ativos em nível baixo. */
static const gpio_num_t s_btn_pins[HAL_BTN_COUNT] = {
    [HAL_BTN_BOOT] = GPIO_NUM_9,
    [HAL_BTN_KEY1] = GPIO_NUM_8,
    [HAL_BTN_KEY2] = GPIO_NUM_10,
};

esp_err_t hal_buttons_init(void)
{
    uint64_t mask = 0;
    for (int i = 0; i < HAL_BTN_COUNT; i++) mask |= 1ULL << s_btn_pins[i];
    const gpio_config_t cfg = {
        .pin_bit_mask = mask,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&cfg), TAG, "gpio botões");
    ESP_LOGI(TAG, "botões em repouso: BOOT=%d KEY1=%d KEY2=%d (esperado 1)",
             gpio_get_level(s_btn_pins[HAL_BTN_BOOT]), gpio_get_level(s_btn_pins[HAL_BTN_KEY1]),
             gpio_get_level(s_btn_pins[HAL_BTN_KEY2]));
    return ESP_OK;
}

bool hal_button_down(hal_btn_t b)
{
    return b < HAL_BTN_COUNT && gpio_get_level(s_btn_pins[b]) == 0;
}
