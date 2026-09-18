/* Wi-Fi em modo estação com várias redes + relógio (SNTP, com a hora do servidor como reserva). */
#pragma once

#include <stdbool.h>
#include <stdint.h>

void net_start(void);

/* O cliente WebSocket avisa se o servidor responde; sem servidor por muito tempo, troca de rede. */
void net_set_server_ok(bool ok);

/* Fuso no formato POSIX (ex.: "<-03>3"), vindo do hello_ack. */
void net_set_tz(const char *posix);
/* Hora do servidor (epoch ms). Só é usada enquanto o SNTP não sincronizou. */
void net_time_hint(int64_t epoch_ms);
bool net_time_valid(void);
int64_t net_epoch_ms(void);
