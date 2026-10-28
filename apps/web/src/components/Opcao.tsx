/** Interruptor de liga/desliga com título e explicação ao lado — o jeito de mostrar uma opção nos ajustes. */
export function Opcao({
  titulo,
  descricao,
  ligada,
  ocupado,
  onTrocar,
}: {
  titulo: string;
  descricao: string;
  ligada: boolean;
  ocupado?: boolean;
  onTrocar(): void;
}) {
  return (
    <div className="opcao">
      <div className="opcao__texto">
        <strong>{titulo}</strong>
        <span>{descricao}</span>
      </div>
      <button type="button" role="switch" aria-checked={ligada} aria-label={titulo} className="switch" disabled={ocupado} onClick={onTrocar}>
        <i aria-hidden="true" />
      </button>
    </div>
  );
}
