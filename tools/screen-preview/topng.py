"""PPM → PNG ampliado (sem Pillow): python3 topng.py entrada.ppm saida.png [escala]"""
import struct, sys, zlib

src, dst = sys.argv[1], sys.argv[2]
k = int(sys.argv[3]) if len(sys.argv) > 3 else 3
data = open(src, 'rb').read()
head, rest = data.split(b'\n', 3)[:3], data.split(b'\n', 3)[3]
w, h = map(int, head[1].split())
rows = []
for y in range(h):
    line = rest[y * w * 3:(y + 1) * w * 3]
    big = b''.join(line[x * 3:x * 3 + 3] * k for x in range(w))
    rows += [b'\0' + big] * k
chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w * k, h * k, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
open(dst, 'wb').write(png)
