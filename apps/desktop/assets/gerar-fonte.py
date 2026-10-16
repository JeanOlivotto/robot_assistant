"""A carinha do Miro como fonte, para a polybar (que só desenha texto): python gerar-fonte.py

Precisa do fontTools (pip install fonttools). Gera miro-icone.ttf com dois caracteres:
  U+E900  acordado (ligado)       U+E901  dormindo (desligado)
Instalar: cp miro-icone.ttf ~/.local/share/fonts/ && fc-cache -f
"""
import math
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

EM = 1000
C = 500  # centro
R = 470  # raio da cara
BORDA = 70


def circulo(pen, r, horario):
    """Círculo em 8 arcos quadráticos. Contorno de fora no sentido horário, furo no anti-horário."""
    n = 8
    passo = (-1 if horario else 1) * 2 * math.pi / n
    k = r / math.cos(math.pi / n)
    pen.moveTo((C + r, C))
    for i in range(n):
        a0, a1 = i * passo, (i + 1) * passo
        meio = (a0 + a1) / 2
        pen.qCurveTo((C + k * math.cos(meio), C + k * math.sin(meio)), (C + r * math.cos(a1), C + r * math.sin(a1)))
    pen.closePath()


def retangulo(pen, x, y, w, h, raio):
    """Retângulo de cantos redondos, sentido horário (y para cima)."""
    pen.moveTo((x + raio, y))
    pen.qCurveTo((x, y), (x, y + raio))
    pen.lineTo((x, y + h - raio))
    pen.qCurveTo((x, y + h), (x + raio, y + h))
    pen.lineTo((x + w - raio, y + h))
    pen.qCurveTo((x + w, y + h), (x + w, y + h - raio))
    pen.lineTo((x + w, y + raio))
    pen.qCurveTo((x + w, y), (x + w - raio, y))
    pen.closePath()


def sorriso(pen):
    """Faixa em arco embaixo dos olhos, como no ícone do app."""
    cy, r0, r1 = 400, 85, 140
    angulos = [math.radians(a) for a in range(200, 341, 10)]
    fora = [(C + r1 * math.cos(a), cy + r1 * math.sin(a)) for a in angulos]
    dentro = [(C + r0 * math.cos(a), cy + r0 * math.sin(a)) for a in reversed(angulos)]
    pts = list(reversed(fora + dentro))  # sentido horário, como o resto
    pen.moveTo(pts[0])
    for p in pts[1:]:
        pen.lineTo(p)
    pen.closePath()


def cara(dormindo):
    pen = TTGlyphPen(None)
    circulo(pen, R, horario=True)
    circulo(pen, R - BORDA, horario=False)
    if dormindo:  # olhos fechados: dois tracinhos
        retangulo(pen, 255, 560, 170, 55, 27)
        retangulo(pen, 575, 560, 170, 55, 27)
    else:
        retangulo(pen, 270, 470, 160, 230, 55)
        retangulo(pen, 570, 470, 160, 230, 55)
    sorriso(pen)
    return pen.glyph()


def vazio():
    return TTGlyphPen(None).glyph()


fb = FontBuilder(EM, isTTF=True)
nomes = ['.notdef', 'miro', 'miro-dormindo']
fb.setupGlyphOrder(nomes)
fb.setupCharacterMap({0xE900: 'miro', 0xE901: 'miro-dormindo'})
fb.setupGlyf({'.notdef': vazio(), 'miro': cara(False), 'miro-dormindo': cara(True)})
fb.setupHorizontalMetrics({n: (EM, 0) for n in nomes})
fb.setupHorizontalHeader(ascent=900, descent=-100)
fb.setupNameTable({'familyName': 'Miro Icone', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=900, sTypoDescender=-100, usWinAscent=900, usWinDescent=100)
fb.setupPost()
fb.save(str(Path(__file__).with_name('miro-icone.ttf')))
print('ok: miro-icone.ttf')
