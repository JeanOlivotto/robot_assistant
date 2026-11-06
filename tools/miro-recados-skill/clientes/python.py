"""Recados do Miro — cliente Python (FastAPI, Celery, scripts). Só biblioteca padrão.

Lê MIRO_RECADOS_URL e MIRO_RECADOS_CHAVE do ambiente (ou do settings do projeto, se houver).
Nunca lança. Em FastAPI, chame por BackgroundTasks; em Celery, de dentro da task mesmo
(já está fora da requisição); em código async, use `asyncio.to_thread(recado, ...)`.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Literal, Optional

log = logging.getLogger(__name__)

Tipo = Literal["suporte", "saude", "cadastro", "outro"]
Prioridade = Literal["urgente", "normal", "baixa"]


def _config() -> tuple[str, str]:
    return os.getenv("MIRO_RECADOS_URL", "").rstrip("/"), os.getenv("MIRO_RECADOS_CHAVE", "")


def _enviar(corpo: dict) -> None:
    url, chave = _config()
    if not url or not chave:
        return
    req = urllib.request.Request(
        f"{url}/api/recados",
        data=json.dumps(corpo, ensure_ascii=False).encode(),
        headers={"Authorization": f"Bearer {chave}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            if res.status >= 300:
                log.warning("Miro recusou o recado (HTTP %s)", res.status)
    except urllib.error.HTTPError as e:
        log.warning("Miro recusou o recado (HTTP %s)", e.code)
    except Exception as e:  # rede, timeout, DNS: o fluxo principal segue
        log.warning("Recado ao Miro não enviado: %s", e)


def recado(
    titulo: str,
    texto: Optional[str] = None,
    tipo: Tipo = "outro",
    prioridade: Prioridade = "normal",
    link: Optional[str] = None,
    chave: Optional[str] = None,
) -> None:
    corpo = {"titulo": titulo[:120], "tipo": tipo, "prioridade": prioridade}
    if texto:
        corpo["texto"] = texto[:2000]
    if link:
        corpo["link"] = link
    if chave:
        corpo["chave"] = chave
    _enviar(corpo)


def resolvido(chave: str, texto: Optional[str] = None) -> None:
    """Fecha o recado aberto com esta chave."""
    corpo: dict = {"chave": chave, "resolvido": True}
    if texto:
        corpo["texto"] = texto[:2000]
    _enviar(corpo)


# Uso (Celery):
#   recado("Fila de NFC-e parada", texto=f"{pendentes} notas esperando há 20 min",
#          tipo="saude", prioridade="urgente", chave="saude:fila-nfce")
#   ...
#   resolvido("saude:fila-nfce", "Fila andando de novo.")
