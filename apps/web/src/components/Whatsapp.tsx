import { useEffect, useState } from 'react';
import { atenderWhatsapp, conectarWhatsapp, desconectarWhatsapp, privacidadeWhatsapp, statusWhatsapp, type StatusWhatsapp } from '../lib/whatsapp';

/**
 * Seção WhatsApp da aba PC. O Miro entra como aparelho conectado (igual ao WhatsApp Web), mas
 * nunca fica "online" nem marca nada como lido — as notificações do celular continuam iguais.
 */
export function Whatsapp({ token }: { token: string }) {
  const [s, setS] = useState<StatusWhatsapp | null>(null);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const recarregar = () =>
    statusWhatsapp(token)
      .then((r) => (setS(r), setErro('')))
      .catch((e: Error) => setErro(e.message));

  useEffect(() => {
    void recarregar();
    // Esperando o QR ser lido, confere mais rápido para o "conectado" aparecer logo.
    const id = setInterval(() => void recarregar(), s?.estado === 'aguardando_qr' || s?.estado === 'conectando' ? 3_000 : 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, s?.estado]);

  const fazer = (acao: () => Promise<StatusWhatsapp>) => {
    setOcupado(true);
    void acao()
      .then((r) => (setS(r), setErro('')))
      .catch((e: Error) => setErro(e.message))
      .finally(() => setOcupado(false));
  };

  const desconectar = () => {
    if (!confirm('Desconectar o WhatsApp? O Miro sai da lista de aparelhos conectados e, para voltar, precisa ler o QR de novo.')) return;
    fazer(() => desconectarWhatsapp(token));
  };

  return (
    <>
      <h4 className="tasks__titulo pc__titulo">WhatsApp</h4>
      {!s ? (
        <p className="hint pc__hint">{erro || 'Carregando…'}</p>
      ) : s.estado === 'conectado' ? (
        <>
          <p className="hint pc__hint">
            Conectado{s.numero ? ` (+${s.numero})` : ''}, {s.contatos ? `${s.contatos} contatos da agenda` : 'puxando os contatos da agenda…'}. Ele só lê quando você pede ("Miro, chegou uma mensagem, vê pra mim") e só manda com o seu
            "sim". Nada fica marcado como lido e o celular continua notificando.
          </p>
          <p className="hint pc__hint">
            {s.privado
              ? `🔒 Privacidade ligada${s.privadoAte > 0 ? ` até ${new Date(s.privadoAte).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}: ele não olha nem guarda nenhuma mensagem.`
              : 'Privacidade desligada: ele guarda na memória as mensagens das últimas horas, para quando você pedir.'}
          </p>
          <p className="hint pc__hint">
            {s.atender
              ? '💬 Quem te manda mensagem chamando o Miro ("Miro, …") conversa com ele — só conversa, assinado por ele, sem fazer nada nem contar nada seu. Recados chegam aqui no chat.'
              : 'Ele não responde ninguém sozinho no WhatsApp.'}
          </p>
          <div className="whats__acoes">
            <button type="button" className="btn btn--ghost" disabled={ocupado} onClick={() => fazer(() => atenderWhatsapp(token, !s.atender))}>
              {s.atender ? 'Não atender quem chama' : 'Atender quem chama o Miro'}
            </button>
            <button type="button" className="btn btn--primary" disabled={ocupado} onClick={() => fazer(() => privacidadeWhatsapp(token, !s.privado))}>
              {s.privado ? 'Pode voltar a olhar' : 'Ligar privacidade'}
            </button>
            <button type="button" className="btn btn--ghost" disabled={ocupado} onClick={desconectar}>
              Desconectar
            </button>
          </div>
        </>
      ) : s.estado === 'aguardando_qr' && s.qr ? (
        <>
          <p className="hint pc__hint">No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho, e leia o código.</p>
          <img className="whats__qr" src={s.qr} alt="QR code para conectar o WhatsApp" />
        </>
      ) : s.estado === 'conectando' ? (
        <p className="hint pc__hint">Conectando…</p>
      ) : (
        <>
          <p className="hint pc__hint">
            Conecte para poder pedir "Miro, vê essa mensagem pra mim" ou "manda no grupo…". Ele entra como aparelho conectado, sem ficar online —
            as notificações do seu celular não mudam.
          </p>
          <div className="whats__acoes">
            <button type="button" className="btn btn--primary" disabled={ocupado} onClick={() => fazer(() => conectarWhatsapp(token))}>
              {ocupado ? 'Gerando código…' : 'Conectar WhatsApp'}
            </button>
          </div>
        </>
      )}
      {erro && s && <p className="hint">{erro}</p>}
    </>
  );
}
