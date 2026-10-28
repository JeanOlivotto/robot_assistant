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
import { speak, setVolume, stopSpeaking, unlockAudio, VOLUME_MAX, volume } from '../lib/speech';
import { Whatsapp } from './Whatsapp';

/** O volume da voz do Miro (no computador, até 200%: às vezes 100% do sistema ainda é baixo). */
function VolumeDoMiro() {
  const [v, setV] = useState(volume);
  const mudar = (novo: number) => {
    setV(novo);
    setVolume(novo);
  };
  const testar = () => {
    unlockAudio();
    stopSpeaking();
    void speak('Tô falando nesse volume aqui. Tá bom assim?');
  };
  return (
    <section className="card ajuste">
      <header className="ajuste__topo">
        <h3>Voz do Miro</h3>
        <p>Volume das falas dele{VOLUME_MAX > 1 ? ' — no computador dá para passar de 100%' : ''}.</p>
      </header>
      <div className="volume__linha">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
        </svg>
        <input
          type="range"
          min={0.1}
          max={VOLUME_MAX}
          step={0.05}
          value={v}
          onChange={(e) => mudar(Number(e.target.value))}
          onPointerUp={testar}
          onKeyUp={(e) => (e.key.startsWith('Arrow') ? testar() : undefined)}
          aria-label="Volume da voz do Miro"
          style={{ '--pct': `${((v - 0.1) / (VOLUME_MAX - 0.1)) * 100}%` } as React.CSSProperties}
        />
        <span className={`volume__valor ${v > 1 ? 'volume__valor--alto' : ''}`}>{Math.round(v * 100)}%</span>
        <button type="button" className="btn btn--ghost btn--mini" onClick={testar}>
          Testar
        </button>
      </div>
      {v > 1 && <p className="hint">Acima de 100% o som é amplificado — se começar a chiar, baixa um pouco.</p>}
    </section>
  );
}

const EXEMPLO: Record<Sistema, string> = {
  linux: 'code ~/Projects/Jean/{projeto}',
  windows: 'code "$HOME\\Projects\\{projeto}"',
  mac: 'open -a "Visual Studio Code" ~/Projects/{projeto}',
};

/**
 * Aba Ajustes: a voz do Miro, quais computadores estão ligados a ele agora, as ações que ele roda SEM
 * pedir aprovação (o resto passa pelo botão "Pode rodar" no chat) e o WhatsApp.
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
    <div className="ajustes">
      <div className="ajustes__grade">
        <VolumeDoMiro />

        <section className="card ajuste">
          <header className="ajuste__topo">
            <h3>Computadores</h3>
            <p>Onde o Miro pode abrir coisas e olhar o seu código.</p>
          </header>
          {!maquinas.length && !desligadas.length ? (
            <p className="hint">Nenhum ainda. Abra o app do computador com "Deixar o Miro usar este computador" ligado na bandeja.</p>
          ) : (
            <ul className="maquinas">
              {maquinas.map((m, i) => (
                <li key={m.nome}>
                  <span className="pill pill--ok">ligado</span>
                  <div className="maquinas__nome">
                    <strong>{m.nome}</strong>
                    <span>
                      {NOME_SISTEMA[m.sistema]}
                      {i === 0 && maquinas.length > 1 && ' · em uso agora'}
                    </span>
                  </div>
                </li>
              ))}
              {desligadas.map((m) => (
                <li key={m.nome}>
                  <span className="pill">desligado</span>
                  <div className="maquinas__nome">
                    <strong>{m.nome}</strong>
                    <span>
                      {NOME_SISTEMA[m.sistema]}
                      {!m.podeLigar && ' · abra o app nele uma vez para ligar daqui'}
                      {m.podeLigar && m.mesmaRede === false && ' · em outra rede: o sinal de ligar não chega'}
                    </span>
                  </div>
                  {m.podeLigar && (
                    <button type="button" className="btn btn--ghost btn--mini" onClick={() => ligar(m.nome)}>
                      Ligar
                    </button>
                  )}
                  <button type="button" className="tasks__drop" aria-label={`Tirar ${m.nome} da lista`} title="Tirar da lista" onClick={() => esquecer(m.nome)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          {aviso && <p className="hint">{aviso}</p>}
        </section>

        <section className="card ajuste">
          <header className="ajuste__topo">
            <h3>Ações rápidas</h3>
            <p>Rodam na hora quando você pede ("Miro, abre o projeto…"). O resto espera o seu "Pode rodar" no chat.</p>
          </header>
          {erro && <p className="hint">{erro}</p>}
          <ul className="acoes">
            {acoes.map((a) =>
              editando !== 'nova' && editando?.id === a.id ? (
                <li key={a.id}>
                  <FormAcao token={token} acao={a} maquinas={maquinas} onPronto={() => (setEditando(null), void recarregar())} onCancelar={() => setEditando(null)} />
                </li>
              ) : (
                <li key={a.id}>
                  <div className="acoes__texto">
                    <strong>{a.descricao}</strong>
                    <code className="pc__comando">{a.comando}</code>
                    <span>
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
            <button type="button" className="btn btn--ghost btn--mini ajuste__mais" onClick={() => setEditando('nova')}>
              + Nova ação
            </button>
          )}
        </section>
      </div>

      <Whatsapp token={token} />
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
