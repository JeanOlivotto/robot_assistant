"""Desenha o ícone do robô (a carinha) em PNG, sem dependências: python3 gerar-icone.py"""
import math, struct, zlib

def png(path, size):
    ss = 4  # supersampling: bordas lisas
    n = size * ss
    px = [[(0, 0, 0, 0)] * n for _ in range(n)]
    c = n / 2
    r = n * 0.47
    for y in range(n):
        for x in range(n):
            d = math.hypot(x + 0.5 - c, y + 0.5 - c)
            if d <= r:
                edge = r - d < n * 0.035
                px[y][x] = (90, 230, 240, 255) if edge else (8, 11, 17, 255)
    def rrect(x0, y0, w, h, rad, col):
        for y in range(int(y0), int(y0 + h)):
            for x in range(int(x0), int(x0 + w)):
                cx = min(max(x, x0 + rad), x0 + w - rad)
                cy = min(max(y, y0 + rad), y0 + h - rad)
                if math.hypot(x - cx, y - cy) <= rad:
                    px[y][x] = col
    eye = (90, 230, 240, 255)
    ew, eh = n * 0.17, n * 0.24
    rrect(n * 0.27, n * 0.27, ew, eh, n * 0.06, eye)
    rrect(n * 0.56, n * 0.27, ew, eh, n * 0.06, eye)
    # sorriso: faixa de arco
    for y in range(n):
        for x in range(n):
            dx, dy = x - c, y - n * 0.60
            d = math.hypot(dx, dy)
            if dy > n * 0.02 and n * 0.09 <= d <= n * 0.14 and abs(dx) < n * 0.13:
                px[y][x] = eye
    rows = []
    for y in range(size):
        row = bytearray(b'\0')
        for x in range(size):
            acc = [0, 0, 0, 0]
            for yy in range(ss):
                for xx in range(ss):
                    p = px[y * ss + yy][x * ss + xx]
                    for k in range(4):
                        acc[k] += p[k]
            row += bytes(v // (ss * ss) for v in acc)
        rows.append(bytes(row))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    data = b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    data += ch(b'IDAT', zlib.compress(b''.join(rows), 9)) + ch(b'IEND', b'')
    open(path, 'wb').write(data)

for s in (22, 32, 64, 128, 256):
    png(f'icone-{s}.png', s)
