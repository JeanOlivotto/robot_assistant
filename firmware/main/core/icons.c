#include "icons.h"

#include "gfx.h"

#define C_BT_NEAR GFX_RGB(70, 150, 255)
#define C_BT_IDLE GFX_RGB(50, 56, 70)

void icon_bluetooth(int x, int y, bool near)
{
    const uint16_t c = near ? C_BT_NEAR : C_BT_IDLE;
    const int cx = x + 3;
    gfx_thick_line(cx, y, cx, y + 10, 1, c);          /* haste */
    gfx_thick_line(cx, y, cx + 3, y + 3, 1, c);       /* ᛒ: seta de cima */
    gfx_thick_line(cx + 3, y + 3, cx - 3, y + 8, 1, c);
    gfx_thick_line(cx, y + 10, cx + 3, y + 7, 1, c);  /* seta de baixo */
    gfx_thick_line(cx + 3, y + 7, cx - 3, y + 2, 1, c);
}
