<?php

/**
 * Recados do Miro — PHP legado, sem framework (extensão curl).
 *
 * Lê MIRO_RECADOS_URL e MIRO_RECADOS_CHAVE do ambiente (getenv) — adapte para o config do
 * sistema se ele não usa variáveis de ambiente. Timeout curto: mesmo síncrono, o pior caso é
 * 3 s; chame depois de gravar o que importa (ou após fastcgi_finish_request(), se for PHP-FPM).
 * Nunca lança.
 */

function miro_recado(array $recado): void
{
    $url = rtrim((string) getenv('MIRO_RECADOS_URL'), '/');
    $chave = (string) getenv('MIRO_RECADOS_CHAVE');
    if ($url === '' || $chave === '') {
        return;
    }
    if (isset($recado['titulo'])) {
        $recado['titulo'] = mb_substr($recado['titulo'], 0, 120);
    }
    if (isset($recado['texto'])) {
        $recado['texto'] = mb_substr($recado['texto'], 0, 2000);
    }

    try {
        $ch = curl_init($url . '/api/recados');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_TIMEOUT => 3,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . $chave,
                'Content-Type: application/json',
            ],
            CURLOPT_POSTFIELDS => json_encode($recado, JSON_UNESCAPED_UNICODE),
        ]);
        curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $erro = curl_error($ch);
        curl_close($ch);
        if ($erro || $status >= 300) {
            error_log('[miro] recado não enviado: ' . ($erro ?: "HTTP $status"));
        }
    } catch (Throwable $e) {
        error_log('[miro] recado não enviado: ' . $e->getMessage());
    }
}

/** Fecha o recado aberto com esta chave. */
function miro_resolvido(string $chave, ?string $texto = null): void
{
    miro_recado(array_filter(['chave' => $chave, 'resolvido' => true, 'texto' => $texto], fn ($v) => $v !== null));
}

/*
 * Uso:
 *   miro_recado([
 *       'tipo' => 'suporte',
 *       'titulo' => 'Chamado novo: ' . $assunto,
 *       'texto' => $nomeCliente . ': ' . $mensagem,
 *       'chave' => 'suporte:' . $idChamado,
 *   ]);
 */
