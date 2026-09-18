# Placa: SpotPear ESP32-C3 "Desktop Trinket / Mini TV" 1.44"

Identificada em 18/09/2026 com `esptool flash-id` e pelo firmware de fábrica.

| Item | Valor |
|---|---|
| Chip | ESP32-C3 (QFN32) rev v0.4, 160 MHz, Wi-Fi + BLE 5 |
| Flash | **16 MB** (fabricante 0x20, device 0x4018) |
| USB | Serial/JTAG nativo (VID 303A, PID 1001) — no Windows aparece como `COMx` |
| MAC | 7c:e8:b1:80:39:30 |
| Firmware de fábrica | Arduino-ESP32 2.0.9 + TFT_eSPI (relógio NTP + clima OpenWeather) |

## Display — ST7735S 128×128

Configuração tirada do firmware de fábrica (`github.com/Spotpear/ESP32C3_1.44inch`, `User_Setup.h` + `setRotation(2)`):

| Parâmetro | Valor |
|---|---|
| Variante TFT_eSPI | `ST7735_GREENTAB3` |
| MADCTL | `0x08` (só BGR — rotação 2) |
| Offset | coluna 2, linha 1 |
| Inversão | desligada (`INVOFF`) |
| SPI | 40 MHz, modo 0 |
| Backlight | direto no 3V3, sem controle |

## Pinos

| Função | GPIO | Obs. |
|---|---|---|
| LCD SCLK | 3 | |
| LCD MOSI | 4 | |
| LCD RST | 5 | |
| LCD DC | 0 | |
| LCD CS | 2 | strapping |
| BOOT | 9 | strapping, ativo em nível baixo |
| KEY1 | 8 | strapping, sem pull-up externo |
| KEY2 | 10 | sem pull-up externo |
| LED | 11 | alimenta a flash — **não usar** |
| Livres (header) | 1, 6, 7, 20, 21 | reservados para I2S (ver doc 2.4) |

## Voltar ao firmware de fábrica

O backup completo (16 MB) fica em `firmware-backup/relogio-original-16MB.bin` (fora do git):

```powershell
esptool --port COM7 write-flash 0 firmware-backup\relogio-original-16MB.bin
```
