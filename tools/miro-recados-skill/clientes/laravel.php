<?php

/**
 * Recados do Miro — cliente Laravel (HTTP client do framework).
 *
 * config/services.php:
 *   'miro' => [
 *       'url' => env('MIRO_RECADOS_URL'),
 *       'chave' => env('MIRO_RECADOS_CHAVE'),
 *   ],
 *
 * Para não segurar a requisição, chame de um Job na fila (ShouldQueue) ou em
 * dispatch(fn () => ...)->afterResponse(). Nunca lança.
 */

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

class MiroRecados
{
    public function ligado(): bool
    {
        return filled(config('services.miro.url')) && filled(config('services.miro.chave'));
    }

    /**
     * @param  array{titulo:string, texto?:string, tipo?:string, prioridade?:string, link?:string, chave?:string}  $recado
     */
    public function recado(array $recado): void
    {
        if (! $this->ligado()) {
            return;
        }
        $recado['titulo'] = Str::limit($recado['titulo'], 117);
        if (isset($recado['texto'])) {
            $recado['texto'] = Str::limit($recado['texto'], 1997);
        }
        $this->enviar($recado);
    }

    /** Fecha o recado aberto com esta chave. */
    public function resolvido(string $chave, ?string $texto = null): void
    {
        if (! $this->ligado()) {
            return;
        }
        $this->enviar(array_filter(['chave' => $chave, 'resolvido' => true, 'texto' => $texto]));
    }

    private function enviar(array $corpo): void
    {
        try {
            $res = Http::timeout(5)
                ->withToken(config('services.miro.chave'))
                ->acceptJson()
                ->post(rtrim(config('services.miro.url'), '/').'/api/recados', $corpo);
            if (! $res->successful()) {
                Log::warning('Miro recusou o recado', ['status' => $res->status()]);
            }
        } catch (Throwable $e) {
            Log::warning('Recado ao Miro não enviado: '.$e->getMessage());
        }
    }
}

/*
 * Uso:
 *   dispatch(fn () => app(MiroRecados::class)->recado([
 *       'tipo' => 'cadastro',
 *       'prioridade' => 'baixa',
 *       'titulo' => "Cadastro novo: {$user->name}",
 *       'chave' => "cadastro:{$user->id}",
 *   ]))->afterResponse();
 */
