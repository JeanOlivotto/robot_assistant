/*
 * Atualização de firmware pelo Wi-Fi (seção 7.4 do doc) — sem cabo.
 *
 * O servidor manda `{"t":"ota", version, url, sha256, size}` quando publica uma versão
 * diferente da que o robô disse no `hello`. O robô baixa, confere o sha256 do que gravou e
 * reinicia. Se a versão nova não conseguir falar com o servidor, o bootloader volta sozinho
 * para a anterior (rollback), então uma atualização ruim não transforma o robô em enfeite.
 */
#pragma once

#include <stdbool.h>

/* No boot: descobre se estamos testando uma imagem recém-instalada. */
void ota_init(void);

/*
 * O servidor respondeu: a versão que está rodando presta. Confirma a imagem e cancela o
 * rollback. Chamado quando chega o hello_ack.
 */
void ota_confirm_running(void);

/* Chegou a mensagem `ota`. Começa a atualizar, se for o caso (mesma versão/erro recente = ignora). */
void ota_offer(const char *version, const char *url, const char *sha256, int size);

/* Está baixando/gravando agora? A UI usa para segurar a tela de atualização. */
bool ota_busy(void);
