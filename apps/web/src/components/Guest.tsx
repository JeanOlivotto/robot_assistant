import { useEffect, useState } from 'react';
import { MeetingRecorder } from '../lib/meeting';
import { MeetingView } from './Meeting';

/**
 * Tela de quem recebeu o link: só o modo reunião, nada do resto do robô.
 * Ele grava e entrega — a ata aparece para o dono, não aqui.
 */
export function Guest({ token }: { token: string }) {
  const [vale, setVale] = useState<'checando' | 'ok' | 'vencido'>('checando');

  useEffect(() => {
    void fetch('/api/meeting/status', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => setVale(r.ok ? 'ok' : 'vencido'))
      .catch(() => setVale('vencido'));
  }, [token]);

  if (vale === 'checando') return <div className="app"><p className="hint">Abrindo…</p></div>;

  if (vale === 'vencido') {
    return (
      <div className="app">
        <div className="guest__box">
          <h2>Link expirado</h2>
          <p className="hint">Este convite não vale mais. Peça um link novo para quem te mandou.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="guest__box">
        <h2>Gravar a reunião</h2>
        <p className="hint">
          Você foi convidado para gravar esta reunião. Ao encerrar, a ata vai direto para quem te mandou o link —
          você não precisa fazer mais nada.
          {MeetingRecorder.podeGravarAba
            ? ' Ao iniciar, o navegador vai pedir qual aba compartilhar: escolha a da reunião e marque a opção de compartilhar o áudio.'
            : ' Este navegador não captura o áudio da chamada, então a gravação vai pelo microfone. Se puder, abra este link no Chrome do computador.'}
        </p>
      </div>
      <MeetingView token={token} guest />
    </div>
  );
}
