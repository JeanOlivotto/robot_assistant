#include "app_state.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static SemaphoreHandle_t s_lock;
static app_snapshot_t s_state;

void app_state_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    configASSERT(s_lock);
}

void app_set_wifi(bool up)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state.wifi_up = up;
    if (!up) s_state.server_up = false;
    xSemaphoreGive(s_lock);
}

void app_set_server(bool up)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state.server_up = up;
    /* Sem servidor não há conversa: não fica "pensando" para sempre. */
    if (!up) s_state.chat.thinking = false;
    xSemaphoreGive(s_lock);
}

void app_set_agenda(const agenda_item_t *items, int n)
{
    if (n > ROBO_AGENDA_MAX_ITEMS) n = ROBO_AGENDA_MAX_ITEMS;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    memcpy(s_state.agenda, items, n * sizeof(agenda_item_t));
    s_state.n_agenda = n;
    xSemaphoreGive(s_lock);
}

void app_push_alert(const alert_t *a)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state.alert = *a;
    s_state.has_alert = true;
    xSemaphoreGive(s_lock);
}

void app_set_chat(const chat_state_t *c)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state.chat = *c;
    xSemaphoreGive(s_lock);
}

void app_push_react(robo_face_t face, uint32_t ms)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state.react_face = face;
    s_state.react_ms = ms;
    s_state.has_react = true;
    xSemaphoreGive(s_lock);
}

void app_push_say(const char *text, uint32_t ms)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    strlcpy(s_state.say, text, sizeof(s_state.say));
    s_state.say_ms = ms;
    s_state.has_say = true;
    xSemaphoreGive(s_lock);
}

void app_snapshot(app_snapshot_t *out)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    *out = s_state;
    s_state.has_alert = false;
    s_state.has_react = false;
    s_state.has_say = false;
    xSemaphoreGive(s_lock);
}
