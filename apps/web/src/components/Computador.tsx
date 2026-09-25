import { type FormEvent, useEffect, useState } from 'react';
import {
  type Acao,
  apagarAcao,
  criarAcao,
  type Desligada,
  editarAcao,
  esquecerMaquina,
  estadoDoBraco,
  ligarMaquina,
  type Maquina,
  NOME_SISTEMA,
  type Sistema,
} from '../lib/braco';

const EXEMPLO: Record<Sistema, string> = {
  linux: 'code ~/Projects/Jean/{projeto}',
  windows: 'code "$HOME\\Projects\\{projeto}"',
  mac: 'open -a "Visual Studio Code" ~/Projects/{projeto}',
};

/**
 * Aba PC: quais computadores estão ligados ao Miro agora, e as ações que ele roda SEM pedir
 * aprovação quando você pede (o resto passa pelo botão "Pode rodar" no chat).
 */
export function Computador({ token }: { token: string }) {
  const [maquinas, setMaquinas] = useState<Maquina[]>([]);
  const [desligadas, setDesligadas] = useState<Desligada[]>([]);
  const [aviso, setAviso] = useState('');
  const [acoes, setAcoes] = useState<Acao[]>([]);
  const [erro, setErro] = useState('');
  const [editando, setEditando] = useState<Acao | 'nova' | null>(null);

  const recarregar = () =>
    estadoDoBraco(token)
      .then((e) => {
        setMaquinas(e.maquinas);
        setDesligadas(e.desligadas ?? []);
        setAcoes(e.acoes);
        setErro('');
      })
      .catch((e: Error) => setErro(e.message));

  useEffect(() => {
    void recarregar();
    const id = setInterval(() => void recarregar(), 15_000); // máquina entrando/saindo
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const ligar = (nome: string) => {
    setAviso(`Ligando ${nome}…`);
    void ligarMaquina(token, nome)
      .then((r) => setAviso(r.ok ? `Sinal enviado. ${nome} costuma aparecer aqui em um ou dois minutos.` : `Não deu: ${r.texto}`))
      .catch((e: Error) => setAviso(e.message));
  };

  const esquecer = (nome: string) => {
    if (!confirm(`Tirar ${nome} da lista? Se ele abrir o app de novo, volta sozinho.`)) return;
    void esquecerMaquina(token, nome).then(recarregar);
  };

  const apagar = (a: Acao) => {
    if (!confirm(`Apagar a ação "${a.descricao}"?`)) return;
    void apagarAcao(token, a.id)
      .then(recarregar)
      .catch((e: Error) => setErro(e.message));
  };

  return (
    <div className="tasks pc">
      <h4 className="tasks__titulo pc__titulo">Computadores</h4>
      {!maquinas.length && !desligadas.length ? (
        <p className="hint">Nenhum ainda. Abra o app do computador (com "Deixar o Miro usar este computador" ligado na bandeja).</p>
      ) : (
        <ul className="tasks__lista">
          {maquinas.map((m, i) => (
            <li key={m.nome} className="tasks__item">
              <span className="pc__ponto" aria-hidden="true" />
              <div className="tasks__texto">
                <span>{m.nome}</span>
                <span className="tasks__meta">
                  {NOME_SISTEMA[m.sistema]}
                  {i === 0 && maquinas.length > 1 && ' · em uso agora'}
                </span>
              </div>
            </li>
          ))}
          {desligadas.map((m) => (
            <li key={m.nome} className="tasks__item">
              <span className="pc__ponto pc__ponto--off" aria-hidden="true" />
              <div className="tasks__texto">
                <span>{m.nome}</span>
                <span className="tasks__meta">
                  {NOME_SISTEMA[m.sistema]} · desligado{!m.podeLigar && ' (abra o app nele uma vez para dar para ligar daqui)'}
                </span>
              </div>
              {m.podeLigar && (
                <button type="button" className="mini-btn" onClick={() => ligar(m.nome)}>
                  Ligar
                </button>
              )}
              <button type="button" className="tasks__drop" aria-label="Tirar da lista" title="Tirar da lista" onClick={() => esquecer(m.nome)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {aviso && <p className="hint pc__hint">{aviso}</p>}

      <h4 className="tasks__titulo pc__titulo">Ações sem aprovação</h4>
      <p className="hint pc__hint">
        Rodam na hora quando você pede ("Miro, abre o projeto robot_assistant"). O que não estiver aqui ele prepara e espera o seu
        "Pode rodar" no chat.
      </p>
      {erro && <p className="hint">{erro}</p>}

      <ul className="tasks__lista">
        {acoes.map((a) =>
          editando !== 'nova' && editando?.id === a.id ? (
            <li key={a.id} className="tasks__item">
              <FormAcao token={token} acao={a} maquinas={maquinas} onPronto={() => (setEditando(null), void recarregar())} onCancelar={() => setEditando(null)} />
            </li>
          ) : (
            <li key={a.id} className="tasks__item">
              <div className="tasks__texto">
                <span>{a.descricao}</span>
                <code className="pc__comando">{a.comando}</code>
                <span className="tasks__meta">
                  {NOME_SISTEMA[a.sistema]}
                  {a.maquina ? ` · só em ${a.maquina}` : ''}
                </span>
              </div>
              <button type="button" className="tasks__drop" aria-label="Editar" title="Editar" onClick={() => setEditando(a)}>
                ✎
              </button>
              <button type="button" className="tasks__drop" aria-label="Apagar" title="Apagar" onClick={() => apagar(a)}>
                ✕
              </button>
            </li>
          ),
        )}
      </ul>
      {!acoes.length && editando !== 'nova' && <p className="hint">Nenhuma ainda.</p>}

      {editando === 'nova' ? (
        <FormAcao token={token} maquinas={maquinas} onPronto={() => (setEditando(null), void recarregar())} onCancelar={() => setEditando(null)} />
      ) : (
        <button type="button" className="mini-btn pc__nova" onClick={() => setEditando('nova')}>
          + Nova ação
        </button>
      )}
    </div>
  );
}

function FormAcao({
  token,
  acao,
  maquinas,
  onPronto,
  onCancelar,
}: {
  token: string;
  acao?: Acao;
  maquinas: Maquina[];
  onPronto(): void;
  onCancelar(): void;
}) {
  const [descricao, setDescricao] = useState(acao?.descricao ?? '');
  const [comando, setComando] = useState(acao?.comando ?? '');
  const [sistema, setSistema] = useState<Sistema>(acao?.sistema ?? maquinas[0]?.sistema ?? 'linux');
  const [maquina, setMaquina] = useState(acao?.maquina ?? '');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const doSistema = maquinas.filter((m) => m.sistema === sistema);
  const pode = descricao.trim().length >= 3 && comando.trim().length > 0 && !salvando;

  const salvar = (e: FormEvent) => {
    e.preventDefault();
    if (!pode) return;
    setSalvando(true);
    const dados = { descricao, comando, sistema, maquina: maquina || undefined };
    (acao ? editarAcao(token, acao.id, dados) : criarAcao(token, dados))
      .then(onPronto)
      .catch((err: Error) => {
        setErro(err.message);
        setSalvando(false);
      });
  };

  return (
    <form className="pc__form" onSubmit={salvar}>
      <input value={descricao} maxLength={160} placeholder="O que faz (ex.: Abrir um projeto no VS Code)" onChange={(e) => setDescricao(e.target.value)} autoFocus />
      <textarea
        value={comando}
        maxLength={1000}
        rows={2}
        spellCheck={false}
        placeholder={EXEMPLO[sistema]}
        onChange={(e) => setComando(e.target.value)}
      />
      <p className="hint pc__hint">
        {sistema === 'windows' ? 'PowerShell.' : 'Terminal (sh).'} Use {'{nome}'} para o que muda a cada vez — ele pergunta ou entende da sua frase.
      </p>
      <div className="pc__linha">
        <select value={sistema} onChange={(e) => (setSistema(e.target.value as Sistema), setMaquina(''))}>
          <option value="linux">Linux</option>
          <option value="windows">Windows</option>
          <option value="mac">Mac</option>
        </select>
        <select value={maquina} onChange={(e) => setMaquina(e.target.value)}>
          <option value="">Qualquer computador {NOME_SISTEMA[sistema]}</option>
          {doSistema.map((m) => (
            <option key={m.nome} value={m.nome}>
              Só em {m.nome}
            </option>
          ))}
          {maquina && !doSistema.some((m) => m.nome === maquina) && <option value={maquina}>Só em {maquina}</option>}
        </select>
      </div>
      {erro && <p className="hint">{erro}</p>}
      <div className="pc__linha">
        <button type="button" className="btn btn--ghost" onClick={onCancelar}>
          Cancelar
        </button>
        <button type="submit" className="btn btn--primary" disabled={!pode}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </form>
  );
}
