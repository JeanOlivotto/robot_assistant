if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/secrets.h")
    message(FATAL_ERROR "Falta firmware/main/secrets.h — copie secrets.example.h para secrets.h e preencha.")
endif()

idf_component_register(
    SRCS
        "app_main.c"
        "core/app_state.c"
        "core/face.c"
        "core/font8x8.c"
        "core/gfx.c"
        "core/life.c"
        "core/net.c"
        "core/ui.c"
        "core/ws_client.c"
        "hal/hal_${IDF_TARGET}.c"
    INCLUDE_DIRS "." "core" "hal"
    PRIV_REQUIRES
        esp_app_format
        esp_driver_gpio
        esp_driver_spi
        esp_driver_usb_serial_jtag
        esp_event
        esp_lcd
        esp_netif
        esp_timer
        esp_wifi
        json
        mbedtls
        nvs_flash
)
