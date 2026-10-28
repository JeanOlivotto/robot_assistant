import { useEffect, useMemo, useState } from 'react';
import { RobotFace } from './RobotFace';
import {
  DONO,
  NOME_DO_TIPO,
  esquecer,
  lerEstado,
  lerGrafo,
  relLegivel,
  type Entidade,
  type EstadoDoMiro,
  type Grafo,
  type TipoEntidade,
} from '../lib/memoria';

const MAX_NOS = 36;
const W = 820;
const H = 540;
const CX = W / 2;
const CY = H / 2;

/** "hoje", "ontem", "há 5 dias". */
function quando(ts: number, now = Date.now()): string {
  const dias = Math.floor((now - ts) / 86_400_000);
  return dias <= 0 ? 'hoje' : dias === 1 ? 'ontem' : `há ${dias} dias`;
}

interface No {
  e: Entidade;
  x: number;
  y: number;
  r: number;
}

/**
 * Raio em volta do dono: quem tem ligação direta com ele fica no anel de dentro, o resto no de fora.
 * Determinístico (sem física): o mesmo grafo sempre desenha igual, e não fica tremendo.
 */
function posicionar(entidades: Entidade[], ligadasAoDono: Set<string>, relacoes: Grafo['relacoes']): No[] {
  const dentro = entidades.filter((e) => ligadasAoDono.has(e.id));
  const fora = entidades.filter((e) => !ligadasAoDono.has(e.id));
  const passo = (lista: unknown[]) => (Math.PI * 2) / Math.max(1, lista.length);
  const anguloDentro = new Map(dentro.map((e, i) => [e.id, -Math.PI / 2 + i * passo(dentro)]));
  // O anel de fora fica na direção do vizinho de dentro: senão a linha "Duda → confeitaria" cruzava o dono
  // e parecia ligação dele. Cada um vai para a direção do vizinho, e só é empurrado quando encosta no anterior.
  const desejado = (e: Entidade, i: number) => {
    for (const r of relacoes) {
      const outro = r.de === e.id ? r.para : r.para === e.id ? r.de : undefined;
      const a = outro ? anguloDentro.get(outro) : undefined;
      if (a !== undefined) return a;
    }
    return -Math.PI / 2 + i * passo(fora);
  };
  const ordenados = fora.map((e, i) => ({ e, a: desejado(e, i) })).sort((x, y) => x.a - y.a);
  const folga = Math.min(0.42, passo(ordenados) * 0.9); // distância mínima entre dois do anel de fora
  ordenados.forEach((x, i) => {
    if (i > 0) x.a = Math.max(x.a, ordenados[i - 1]!.a + folga);
  });
  const no =(e: Entidade, a: number, rx: number, ry: number): No => ({
    e,
    x: CX + Math.cos(a) * rx,
    y: CY + Math.sin(a) * ry,
    r: 9 + Math.min(9, e.mentions * 1.4),
  });
  return [
    ...dentro.map((e) => no(e, anguloDentro.get(e.id)!, 175, 130)),
    ...ordenados.map((x) => no(x.e, x.a, 345, 225)),
  ];
}

export function Memoria({ token }: { token: string }) {
  const [grafo, setGrafo] = useState<Grafo | null>(null);
  const [estado, setEstado] = useState<EstadoDoMiro | null>(null);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [tipos, setTipos] = useState<Set<TipoEntidade>>(new Set());
  const [foco, setFoco] = useState<string | null>(null);
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState(false);

  const recarregar = () => {
    lerGrafo(token)
      .then((g) => {
        setGrafo(g);
        setErro('');
      })
      .catch((e: Error) => setErro(e.message));
    lerEstado(token)
      .then(setEstado)
      .catch(() => undefined);
  };

  useEffect(() => {
    recarregar();
    const id = setInterval(recarregar, 60_000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => setConfirmar(false), [escolhido]);

  const porId = useMemo(() => new Map((grafo?.entidades ?? []).map((e) => [e.id, e])), [grafo]);
  const nomeDe = (id: string) => (id === DONO ? grafo?.dono ?? 'você' : porId.get(id)?.nome ?? '?');

  const contagem = useMemo(() => {
    const c = new Map<TipoEntidade, number>();
    for (const e of grafo?.entidades ?? []) c.set(e.tipo, (c.get(e.tipo) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [grafo]);

  const nos = useMemo(() => {
    if (!grafo) return [];
    const q = busca.trim().toLowerCase();
    const visiveis = grafo.entidades
      .filter((e) => !tipos.size || tipos.has(e.tipo))
      .filter((e) => !q || [e.nome, ...e.apelidos].some((n) => n.toLowerCase().includes(q)))
      .sort((a, b) => b.mentions - a.mentions || b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_NOS);
    const ligadas = new Set(grafo.relacoes.flatMap((r) => (r.para === DONO ? [r.de] : r.de === DONO && r.para ? [r.para] : [])));
    return posicionar(visiveis, ligadas, grafo.relacoes);
  }, [grafo, busca, tipos]);

  const ondeEsta = useMemo(() => new Map(nos.map((n) => [n.e.id, n])), [nos]);
  const arestas = (grafo?.relacoes ?? []).filter(
    (r) => r.para && (r.de === DONO || ondeEsta.has(r.de)) && (r.para === DONO || ondeEsta.has(r.para)),
  );
  const ponto = (id: string) => (id === DONO ? { x: CX, y: CY } : ondeEsta.get(id)!);

  const ativo = foco ?? escolhido;
  const vizinhos = useMemo(() => {
    if (!ativo || !grafo) return null;
    const v = new Set([ativo]);
    for (const r of grafo.relacoes) {
      if (r.de === ativo && r.para) v.add(r.para);
      if (r.para === ativo) v.add(r.de);
    }
    return v;
  }, [ativo, grafo]);

  const sel = escolhido ? porId.get(escolhido) : undefined;
  const ligacoesDoSel = sel ? (grafo?.relacoes ?? []).filter((r) => r.de === sel.id || r.para === sel.id) : [];

  const alternarTipo = (t: TipoEntidade) =>
    setTipos((atual) => {
      const novo = new Set(atual);
      if (novo.has(t)) novo.delete(t);
      else novo.add(t);
      return novo;
    });

  const apagar = async () => {
    if (!sel) return;
    if (!confirmar) return setConfirmar(true);
    try {
      await esquecer(token, sel.nome);
      setEscolhido(null);
      recarregar();
    } catch (e) {
      setErro((e as Error).message);
    }
  };

  return (
    <div className="memoria">
      <section className="memoria__topo card">
        <div className="memoria__humor">
          <RobotFace face={estado?.humor?.face ?? 'neutral'} size={56} />
          <div>
            <span className="eyebrow">Como o Miro está</span>
            <p>{estado?.humor ? estado.humor.descricao : 'Tranquilo, sem nada marcante nas últimas horas.'}</p>
          </div>
        </div>
        {!!estado?.diario.length && (
          <div className="memoria__diario">
            <span className="eyebrow">Diário dele</span>
            {estado.diario.map((d) => {
              const [dia, ...resto] = d.split(': ');
              return (
                <p key={d}>
                  <strong>{dia}</strong> {resto.join(': ')}
                </p>
              );
            })}
          </div>
        )}
      </section>

      <section className="memoria__grafo card">
        <div className="memoria__barra">
          <input
            type="search"
            value={busca}
            placeholder="Procurar pessoa, projeto…"
            onChange={(e) => setBusca(e.target.value)}
            aria-label="Procurar na memória"
          />
          <div className="memoria__tipos">
            {contagem.map(([t, n]) => (
              <button
                key={t}
                type="button"
                className={`chip chip--tipo tipo--${t} ${tipos.has(t) ? 'chip--on' : ''}`}
                onClick={() => alternarTipo(t)}
                aria-pressed={tipos.has(t)}
              >
                <i aria-hidden="true" />
                {NOME_DO_TIPO[t]} <span>{n}</span>
              </button>
            ))}
          </div>
        </div>

        {erro && <p className="hint">{erro}</p>}
        {grafo && !grafo.entidades.length && (
          <p className="memoria__vazio">Ele ainda não guardou nada sobre você. Conforme vocês conversam, as pessoas e os projetos aparecem aqui.</p>
        )}

        {!!nos.length && (
          <div className="memoria__palco">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Mapa do que o Miro lembra" onClick={() => setEscolhido(null)}>
              <defs>
                <radialGradient id="mem-dono" cx="50%" cy="40%" r="60%">
                  <stop offset="0%" stopColor="var(--accent)" />
                  <stop offset="100%" stopColor="var(--accent-2)" />
                </radialGradient>
              </defs>
              {arestas.map((r, i) => {
                const a = ponto(r.de);
                const b = ponto(r.para!);
                const aceso = !vizinhos || (vizinhos.has(r.de) && vizinhos.has(r.para!));
                return (
                  <g key={i} className={`aresta ${aceso ? (vizinhos ? 'aresta--acesa' : '') : 'aresta--apagada'}`}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                    {vizinhos && aceso && (
                      <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6}>
                        {relLegivel(r.rel)}
                      </text>
                    )}
                  </g>
                );
              })}

              <g className={`no no--dono ${vizinhos && !vizinhos.has(DONO) ? 'no--apagado' : ''}`}>
                <circle cx={CX} cy={CY} r={30} fill="url(#mem-dono)" />
                <text x={CX} y={CY + 5} className="no__dono">
                  {grafo?.dono.slice(0, 10)}
                </text>
              </g>

              {nos.map((n) => {
                const apagado = vizinhos && !vizinhos.has(n.e.id);
                return (
                  <g
                    key={n.e.id}
                    className={`no tipo--${n.e.tipo} ${apagado ? 'no--apagado' : ''} ${escolhido === n.e.id ? 'no--escolhido' : ''}`}
                    onMouseEnter={() => setFoco(n.e.id)}
                    onMouseLeave={() => setFoco(null)}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setEscolhido(n.e.id === escolhido ? null : n.e.id);
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={n.e.nome}
                    onKeyDown={(ev) => ev.key === 'Enter' && setEscolhido(n.e.id)}
                  >
                    <circle cx={n.x} cy={n.y} r={n.r + 6} className="no__halo" />
                    <circle cx={n.x} cy={n.y} r={n.r} className="no__bola" />
                    <text x={n.x} y={n.y + n.r + 16}>
                      {n.e.nome.length > 22 ? `${n.e.nome.slice(0, 21)}…` : n.e.nome}
                    </text>
                  </g>
                );
              })}
            </svg>

            {sel && (
              <aside className={`memoria__ficha tipo--${sel.tipo}`}>
                <span className="eyebrow">{NOME_DO_TIPO[sel.tipo]}</span>
                <h3>{sel.nome}</h3>
                {!!sel.apelidos.length && <p className="dim">também: {sel.apelidos.join(', ')}</p>}
                <ul>
                  {ligacoesDoSel.map((r, i) => (
                    <li key={i}>
                      {r.de === sel.id ? (
                        <>
                          {relLegivel(r.rel)} <strong>{r.valor ?? nomeDe(r.para!)}</strong>
                        </>
                      ) : (
                        <>
                          <strong>{nomeDe(r.de)}</strong> {relLegivel(r.rel)} {sel.nome}
                        </>
                      )}
                    </li>
                  ))}
                  {!ligacoesDoSel.length && <li className="dim">Sem ligações ainda.</li>}
                </ul>
                <p className="dim">
                  Citado {sel.mentions}× · visto {quando(sel.lastSeenAt)}
                </p>
                <button type="button" className={`mini-btn ${confirmar ? 'mini-btn--perigo' : ''}`} onClick={() => void apagar()}>
                  {confirmar ? 'Esquecer mesmo?' : 'Esquecer'}
                </button>
              </aside>
            )}
          </div>
        )}
        {grafo && grafo.entidades.length > nos.length && !busca && (
          <p className="hint">Mostrando as {nos.length} mais citadas de {grafo.entidades.length}. Use a busca para achar o resto.</p>
        )}
      </section>
    </div>
  );
}
