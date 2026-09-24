/* Presença pelo Bluetooth: escuta os anúncios BLE dos aparelhos Apple por perto e conta ao
 * servidor a força do sinal de cada um. Só escuta — o robô não anuncia nem conecta em nada. */
#pragma once

void presence_start(void);
/* Desliga o Bluetooth e devolve a memória dele — o download do OTA precisa de uma segunda
 * conexão TLS, e com os dois ligados não cabe. presence_start() religa. */
void presence_stop(void);
