import { type FormEvent, useEffect, useState } from 'react';
import {
  type AppRecados,
  apagarApp,
  baixarSkill,
  criarApp,
  darBaixa,
  listarAbertos,
  listarApps,
  mudarApp,
  nomeDeApp,
  novaChave,
  type Recado,
} from '../lib/recados';

const ICONE: Record<Recado['tipo'], string> = { suporte: '💬', saude: '🩺', cadastro: '🆕', outro: '📨' };

/** "agora", "há 5 min", "há 3 h", "há 2 dias". */
function quando(ms: number, now = Date.now()): string {
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} dia${d > 1 ? 's' : ''}`;
}

/**
 * Cartão dos recados nos ajustes: os sistemas do dono que avisam o Miro (suporte, saúde, cadastros).
 * Cada um com a própria chave de API — é ela que diz de onde veio o recado.
 */
export function Recados({ token }: { token: string }) {
  const [apps, setApps] = useState<AppRecados[]>([]);
  const [abertos, setAbertos] = useState<Recado[]>([]);
  const [erro, setErro] = useState('');
  const [criando, setCriando] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  /** Chave recém-gerada: só aparece agora. */
  const [chave, setChave] = useState<{ app: string; token: string } | null>(null);

  const recarregar = () =>
    Promise.all([listarApps(token), listarAbertos(token)])
      .then(([a, r]) => (setApps(a), setAbertos(r), setErro('')))
      .catch((e: Error) => setErro(e.message));

  useEffect(() => {
    void recarregar();
    const id = setInterval(() => void recarregar(), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const fazer = (p: Promise<unknown>) =>
    void p.then(recarregar).catch((e: Error) => setErro(e.message));

  const trocarChave = (a: AppRecados) => {
    if (!confirm(`Gerar uma chave nova para ${a.nome}? A atual (${a.prefixo}…) para de funcionar na hora — o sistema precisa receber a nova.`)) return;
    fazer(novaChave(token, a.nome).then((r) => setChave({ app: a.nome, token: r.token })));
  };

  const apagar = (a: AppRecados) => {
    if (!confirm(`Apagar ${a.nome}? A chave para de funcionar. Os recados que já chegaram continuam no histórico.`)) return;
    if (chave?.app === a.nome) setChave(null);
    fazer(apagarApp(token, a.nome));
  };

  return (
    <section className="card ajuste recados">
      <header className="ajuste__topo">
        <h3>Recados dos sistemas</h3>
        <p>Seus sistemas avisam o Miro de suporte, saúde e cadastros, e ele te conta. Cada sistema tem a própria chave: é por ela que ele sabe de onde veio o recado.</p>
      </header>

      {chave && <ChaveNova app={chave.app} token={chave.token} onFechar={() => setChave(null)} />}

      {apps.length > 0 && (
        <ul className="acoes">
          {apps.map((a) =>
            editando === a.nome ? (
              <li key={a.nome}>
                <FormSaude
                  app={a}
                  onSalvar={(url) => (setEditando(null), fazer(mudarApp(token, a.nome, { saudeUrl: url })))}
                  onCancelar={() => setEditando(null)}
                />
              </li>
            ) : (
              <li key={a.nome} className={a.ativo ? '' : 'recados__off'}>
                <div className="acoes__texto">
                  <strong>
                    {a.nome}
                    {a.abertos > 0 && <span className="tab-badge recados__badge">{a.abertos}</span>}
                  </strong>
                  <span>
                    chave <code>{a.prefixo}…</code> · {a.recebidos} recado{a.recebidos === 1 ? '' : 's'}
                    {a.ultimoRecadoEm ? ` · último ${quando(a.ultimoRecadoEm)}` : ' · nenhum ainda'}
                  </span>
                  <span>
                    {!a.ativo ? (
                      'desativada: recusa recados e não é vigiada'
                    ) : !a.saudeUrl ? (
                      'sem vigia de saúde'
                    ) : (
                      <>
                        <span className={`pill pill--mini ${!a.saude ? '' : a.saude.ok ? 'pill--ok' : 'pill--erro'}`}>
                          {!a.saude ? 'vigiando' : a.saude.ok ? 'no ar' : 'falhando'}
                        </span>{' '}
                        {a.saude && !a.saude.ok ? `${a.saude.erro} · ` : ''}
                        {a.saudeUrl}
                      </>
                    )}
                  </span>
                </div>
                <div className="recados__acoes">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={a.ativo}
                    aria-label={`${a.nome} ${a.ativo ? 'ativa' : 'desativada'}`}
                    title={a.ativo ? 'Ativa — clique para desativar' : 'Desativada — clique para ativar'}
                    className="switch"
                    onClick={() => fazer(mudarApp(token, a.nome, { ativo: !a.ativo }))}
                  >
                    <i aria-hidden="true" />
                  </button>
                  <button type="button" className="btn btn--ghost btn--mini" onClick={() => trocarChave(a)}>
                    Nova chave
                  </button>
                  <button type="button" className="tasks__drop" aria-label="Editar a URL de saúde" title="Editar a URL de saúde" onClick={() => setEditando(a.nome)}>
                    ✎
                  </button>
                  <button type="button" className="tasks__drop" aria-label={`Apagar ${a.nome}`} title="Apagar" onClick={() => apagar(a)}>
                    ✕
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {!apps.length && !criando && <p className="hint">Nenhum sistema ainda.</p>}

      {criando ? (
        <FormNova
          token={token}
          onPronto={(app, t) => (setCriando(false), setChave({ app, token: t }), void recarregar())}
          onCancelar={() => setCriando(false)}
        />
      ) : (
        <button type="button" className="btn btn--ghost btn--mini ajuste__mais" onClick={() => setCriando(true)}>
          + Novo sistema
        </button>
      )}

      {abertos.length > 0 && (
        <div className="recados__abertos">
          <strong>Abertos</strong>
          <ul className="tasks__lista">
            {abertos.slice(0, 10).map((r) => (
              <li key={r.id} className="tasks__item">
                <button type="button" className="tasks__check" aria-label="Dar baixa" title="Dar baixa" onClick={() => fazer(darBaixa(token, r.id))} />
                <div className="tasks__texto">
                  <span>
                    {r.prioridade === 'urgente' ? '🚨' : ICONE[r.tipo]} {r.titulo}
                    {r.vezes > 1 && ` (${r.vezes}x)`}
                  </span>
                  <span className="tasks__meta">
                    {r.app} · {r.tipo}
                    {r.prioridade !== 'normal' && ` · ${r.prioridade}`} · {quando(r.atualizadoEm)}
                    {r.link && (
                      <>
                        {' · '}
                        <a href={r.link} target="_blank" rel="noreferrer noopener">
                          abrir
                        </a>
                      </>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {abertos.length > 10 && <p className="hint">E mais {abertos.length - 10}. Pergunte ao Miro: "o que tem de recado?"</p>}
        </div>
      )}
      <ComoImplantar token={token} />
      {erro && <p className="hint">{erro}</p>}
    </section>
  );
}

const PEDIDO = 'Liga os recados do Miro neste sistema (suporte, saúde e cadastros).';
const INSTALAR: { so: string; comando: string }[] = [
  { so: 'Linux / Mac', comando: 'mkdir -p ~/.claude/skills && unzip -o ~/Downloads/miro-recados.zip -d ~/.claude/skills' },
  {
    so: 'Windows (PowerShell)',
    comando: 'Expand-Archive -Force "$env:USERPROFILE\\Downloads\\miro-recados.zip" "$env:USERPROFILE\\.claude\\skills"',
  },
];

/**
 * Como levar os recados para um sistema: a skill do Claude Code faz o trabalho (acha os pontos,
 * escreve o cliente da stack, testa). Daqui sai o .zip e o comando para instalar.
 */
function ComoImplantar({ token }: { token: string }) {
  const [copiado, setCopiado] = useState('');
  const [baixando, setBaixando] = useState(false);
  const [erro, setErro] = useState('');

  const copiar = (oQue: string, texto: string) =>
    void navigator.clipboard
      ?.writeText(texto)
      .then(() => {
        setCopiado(oQue);
        setTimeout(() => setCopiado(''), 2000);
      })
      .catch(() => setErro('Não consegui copiar — selecione e copie à mão.'));

  const baixar = () => {
    setBaixando(true);
    setErro('');
    void baixarSkill(token)
      .catch((e: Error) => setErro(e.message))
      .finally(() => setBaixando(false));
  };

  const linha = (id: string, texto: string) => (
    <div className="meeting__link-linha">
      <code className="meeting__link recados__cmd">{texto}</code>
      <button type="button" className="mini-btn" onClick={() => copiar(id, texto)}>
        {copiado === id ? 'Copiado ✓' : 'Copiar'}
      </button>
    </div>
  );

  return (
    <details className="recados__skill">
      <summary>Como implantar num sistema</summary>
      <p className="hint">
        Com a skill <strong>miro-recados</strong> no Claude Code, ele mesmo acha os pontos certos (suporte, saúde, cadastro), escreve o
        cliente da stack (NestJS, Laravel, PHP, Python) e testa. Você só aprova a lista e cola a chave no .env do sistema.
      </p>

      <ol className="recados__passos">
        <li>
          <span>Baixe a skill</span>
          <button type="button" className="btn btn--ghost btn--mini" disabled={baixando} onClick={baixar}>
            {baixando ? 'Baixando…' : 'Baixar miro-recados.zip'}
          </button>
        </li>
        <li>
          <span>Instale (descompacta em ~/.claude/skills)</span>
          {INSTALAR.map((i) => (
            <div key={i.so} className="recados__so">
              <small>{i.so}</small>
              {linha(i.so, i.comando)}
            </div>
          ))}
        </li>
        <li>
          <span>Crie o sistema aqui em cima e guarde a chave no .env dele</span>
          {linha('env', 'MIRO_RECADOS_URL=' + location.origin + '\nMIRO_RECADOS_CHAVE=rcd_…')}
        </li>
        <li>
          <span>No projeto, peça ao Claude Code (ou rode /miro-recados)</span>
          {linha('pedido', PEDIDO)}
        </li>
      </ol>
      <p className="hint">No computador onde está o repositório do Miro a skill já está instalada e se atualiza sozinha.</p>
      {erro && <p className="hint">{erro}</p>}
    </details>
  );
}

function FormNova({ token, onPronto, onCancelar }: { token: string; onPronto(app: string, token: string): void; onCancelar(): void }) {
  const [nome, setNome] = useState('');
  const [saude, setSaude] = useState('');
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const salvar = (e: FormEvent) => {
    e.preventDefault();
    const n = nome.replace(/-+$/, '');
    if (!n) return;
    setOcupado(true);
    void criarApp(token, n, saude.trim())
      .then((r) => onPronto(r.app.nome, r.token))
      .catch((err: Error) => setErro(err.message))
      .finally(() => setOcupado(false));
  };

  return (
    <form className="pc__form" onSubmit={salvar}>
      <input value={nome} maxLength={31} placeholder="Nome do sistema (ex.: baixaxml)" onChange={(e) => setNome(nomeDeApp(e.target.value))} autoFocus />
      <input
        value={saude}
        type="url"
        placeholder="URL de saúde, opcional (ex.: https://baixaxml.com.br/health)"
        onChange={(e) => setSaude(e.target.value)}
      />
      <p className="hint pc__hint">Com a URL de saúde, o Miro confere a cada 2 min e avisa se o sistema cair — mesmo sem ele conseguir mandar recado.</p>
      {erro && <p className="hint">{erro}</p>}
      <div className="pc__linha">
        <button type="button" className="btn btn--ghost btn--mini" onClick={onCancelar}>
          Cancelar
        </button>
        <button type="submit" className="btn btn--primary btn--mini" disabled={!nome || ocupado}>
          {ocupado ? 'Gerando…' : 'Criar e gerar chave'}
        </button>
      </div>
    </form>
  );
}

function FormSaude({ app, onSalvar, onCancelar }: { app: AppRecados; onSalvar(url: string): void; onCancelar(): void }) {
  const [url, setUrl] = useState(app.saudeUrl ?? '');
  return (
    <form className="pc__form" onSubmit={(e) => (e.preventDefault(), onSalvar(url.trim()))}>
      <strong>{app.nome}</strong>
      <input value={url} type="url" placeholder="URL de saúde (vazio = sem vigia)" onChange={(e) => setUrl(e.target.value)} autoFocus />
      <div className="pc__linha">
        <button type="button" className="btn btn--ghost btn--mini" onClick={onCancelar}>
          Cancelar
        </button>
        <button type="submit" className="btn btn--primary btn--mini">
          Salvar
        </button>
      </div>
    </form>
  );
}

/** A chave recém-gerada, com o exemplo de uso. Fechou, sumiu: o servidor só guarda o hash. */
function ChaveNova({ app, token, onFechar }: { app: string; token: string; onFechar(): void }) {
  const [copiado, setCopiado] = useState('');
  const curl =
    `curl -X POST ${location.origin}/api/recados \\\n` +
    `  -H "Authorization: Bearer ${token}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"tipo":"suporte","prioridade":"normal","titulo":"Teste do ${app}","texto":"Se chegou, está funcionando."}'`;
  const copiar = (oQue: string, texto: string) =>
    void navigator.clipboard
      ?.writeText(texto)
      .then(() => {
        setCopiado(oQue);
        setTimeout(() => setCopiado(''), 2000);
      })
      .catch(() => setCopiado('erro'));

  return (
    <div className="recados__chave" role="status">
      <strong>Chave de {app}</strong>
      <span className="hint">Copie agora e guarde no .env do sistema: ela não aparece de novo. Se perder, gere outra.</span>
      <div className="meeting__link-linha">
        <code className="meeting__link">{token}</code>
        <button type="button" className="mini-btn" onClick={() => copiar('chave', token)}>
          {copiado === 'chave' ? 'Copiado ✓' : 'Copiar'}
        </button>
      </div>
      <details>
        <summary>Testar com curl</summary>
        <pre className="pc__comando">{curl}</pre>
        <button type="button" className="btn btn--ghost btn--mini" onClick={() => copiar('curl', curl)}>
          {copiado === 'curl' ? 'Copiado ✓' : 'Copiar comando'}
        </button>
      </details>
      {copiado === 'erro' && <p className="hint">Não consegui copiar — selecione e copie à mão.</p>}
      <button type="button" className="btn btn--ghost btn--mini ajuste__mais" onClick={onFechar}>
        Já guardei
      </button>
    </div>
  );
}
