import { useState, type FormEvent } from 'react';
import { checkToken } from '../lib/useRobo';
import { RobotFace } from './RobotFace';

export function Login({ onLogin }: { onLogin(token: string): void }) {
  const [token, setToken] = useState('');
  const [state, setState] = useState<'idle' | 'checking' | 'wrong' | 'offline'>('idle');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setState('checking');
    try {
      if (await checkToken(token.trim())) onLogin(token.trim());
      else setState('wrong');
    } catch {
      setState('offline');
    }
  };

  return (
    <main className="login">
      <RobotFace face={state === 'wrong' ? 'sad' : state === 'checking' ? 'thinking' : 'neutral'} size={140} />
      <h1>Oi! Eu sou o robô.</h1>
      <form onSubmit={submit}>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Senha do app (APP_TOKEN)"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setState('idle');
          }}
        />
        <button className="btn btn--primary" disabled={state === 'checking'}>
          Entrar
        </button>
      </form>
      {state === 'wrong' && <p className="error">Senha errada.</p>}
      {state === 'offline' && <p className="error">Não achei o servidor.</p>}
    </main>
  );
}
