import { useEffect, useState } from 'react';
import { type GrupoWhatsapp, grupoTecnico, gruposWhatsapp } from '../lib/whatsapp';
import { atenderWhatsapp, conectarWhatsapp, desconectarWhatsapp, privacidadeWhatsapp, statusWhatsapp, type StatusWhatsapp } from '../lib/whatsapp';
import { Opcao } from './Opcao';

/**
 * Cartão do WhatsApp nos ajustes. O Miro entra como aparelho conectado (igual ao WhatsApp Web), mas
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

  const ate =
    s?.privado && s.privadoAte > 0
      ? ` até ${new Date(s.privadoAte).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : '';

  return (
    <section className="card ajuste whats">
      <header className="ajuste__topo whats__topo">
        <div>
          <h3>WhatsApp</h3>
          <p>
            {s?.estado === 'conectado'
              ? `+${s.numero ?? '?'} · ${s.contatos ? `${s.contatos} contatos` : 'puxando os contatos…'}`
              : 'Ele entra como aparelho conectado, sem ficar online — o celular continua notificando igual.'}
          </p>
        </div>
        {s && (
          <span className={`pill ${s.estado === 'conectado' ? 'pill--ok' : s.estado === 'desligado' ? '' : 'pill--espera'}`}>
            {s.estado === 'conectado' ? 'conectado' : s.estado === 'desligado' ? 'desconectado' : s.estado === 'aguardando_qr' ? 'esperando o QR' : 'conectando…'}
          </span>
        )}
      </header>

      {!s ? (
        <p className="hint">{erro || 'Carregando…'}</p>
      ) : s.estado === 'conectado' ? (
        <>
          <p className="whats__resumo">
            Ele só lê quando você pede ("Miro, vê essa mensagem pra mim") e só manda com o seu "sim". Nada fica marcado como lido.
          </p>
          <div className="opcoes">
            <Opcao
              titulo="Privacidade"
              descricao={
                s.privado
                  ? `Ligada${ate}: ele não olha nem guarda nenhuma mensagem.`
                  : 'Desligada: ele guarda as mensagens das últimas horas, para quando você pedir.'
              }
              ligada={s.privado}
              ocupado={ocupado}
              onTrocar={() => fazer(() => privacidadeWhatsapp(token, !s.privado))}
            />
            <Opcao
              titulo="Atender quem chama o Miro"
              descricao='Quem escreve "Miro, …" (no privado ou num grupo) conversa com ele — assinado por ele, sem contar nada seu. Os recados chegam no chat.'
              ligada={s.atender}
              ocupado={ocupado}
              onTrocar={() => fazer(() => atenderWhatsapp(token, !s.atender))}
            />
          </div>
          {s.atender && <GruposTecnicos token={token} />}
          <footer className="whats__rodape">
            <span>
              {s.ultimoChamado
                ? `Último chamado: ${s.ultimoChamado.quem}, ${new Date(s.ultimoChamado.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} — ${s.ultimoChamado.resultado}.`
                : ''}
            </span>
            <button type="button" className="btn btn--ghost btn--mini btn--perigo" disabled={ocupado} onClick={desconectar}>
              Desconectar
            </button>
          </footer>
        </>
      ) : s.estado === 'aguardando_qr' && s.qr ? (
        <>
          <p className="hint">No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho, e leia o código.</p>
          <img className="whats__qr" src={s.qr} alt="QR code para conectar o WhatsApp" />
        </>
      ) : s.estado === 'conectando' ? (
        <p className="hint">Conectando…</p>
      ) : (
        <>
          <p className="whats__resumo">Conecte para pedir "Miro, vê essa mensagem pra mim" ou "manda no grupo…".</p>
          <button type="button" className="btn btn--primary" disabled={ocupado} onClick={() => fazer(() => conectarWhatsapp(token))}>
            {ocupado ? 'Gerando código…' : 'Conectar WhatsApp'}
          </button>
        </>
      )}
      {erro && s && <p className="hint">{erro}</p>}
    </section>
  );
}

/**
 * Grupos onde o Miro tira dúvida de código: lê os seus projetos (~/Projects, no computador ligado)
 * e explica em palavras — nunca cola código nem segredo.
 */
function GruposTecnicos({ token }: { token: string }) {
  const [grupos, setGrupos] = useState<GrupoWhatsapp[]>([]);
  const [busca, setBusca] = useState('');
  const [erro, setErro] = useState('');

  useEffect(() => {
    void gruposWhatsapp(token)
      .then(setGrupos)
      .catch((e: Error) => setErro(e.message));
  }, [token]);

  const trocar = (g: GrupoWhatsapp) =>
    void grupoTecnico(token, g.id, !g.tecnico)
      .then(setGrupos)
      .catch((e: Error) => setErro(e.message));

  if (!grupos.length) return null;
  const termo = busca.trim().toLowerCase();
  const liberados = grupos.filter((g) => g.tecnico);
  const achados = termo ? grupos.filter((g) => !g.tecnico && g.nome.toLowerCase().includes(termo)).slice(0, 8) : [];
  return (
    <div className="whats__grupos">
      <div className="opcao__texto">
        <strong>Dúvidas de código nos grupos</strong>
        <span>Nos grupos liberados, quem chama o Miro pode perguntar como algo dos seus projetos funciona. Ele lê sem mexer e explica em palavras — sem colar código nem segredo.</span>
      </div>
      <div className="whats__liberados">
        {liberados.map((g) => (
          <button key={g.id} type="button" className="chip chip--on chip--x" onClick={() => trocar(g)} title="Tirar a liberação">
            {g.nome} <span aria-hidden="true">✕</span>
          </button>
        ))}
        {!liberados.length && <span className="hint">Nenhum grupo liberado.</span>}
      </div>
      <input className="whats__busca" placeholder="Procurar grupo para liberar…" value={busca} onChange={(e) => setBusca(e.target.value)} />
      {!!achados.length && (
        <div className="whats__liberados">
          {achados.map((g) => (
            <button key={g.id} type="button" className="chip" onClick={() => (trocar(g), setBusca(''))}>
              + {g.nome}
            </button>
          ))}
        </div>
      )}
      {erro && <p className="hint">{erro}</p>}
    </div>
  );
}
