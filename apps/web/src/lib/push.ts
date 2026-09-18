/** Notificação no celular (Web Push). No iPhone só existe com o app adicionado à Tela de Início. */

export type PushState = 'unsupported' | 'needs-install' | 'default' | 'granted' | 'denied';

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export function pushState(): PushState {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  return Notification.permission;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function api(token: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`/api/push/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Inscreve este aparelho (ou renova a inscrição) no servidor. */
async function subscribe(token: string): Promise<void> {
  const { enabled, publicKey } = (await (await api(token, 'key')).json()) as { enabled: boolean; publicKey: string };
  if (!enabled) throw new Error('as notificações estão desligadas no servidor');
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  const res = await api(token, 'subscribe', { subscription: sub.toJSON() });
  if (!res.ok) throw new Error(`o servidor recusou a inscrição (${res.status})`);
}

/** Pede permissão (precisa vir de um toque) e inscreve. */
export async function enablePush(token: string): Promise<void> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('permissão negada');
  await subscribe(token);
}

/** Ao abrir o app: se já tem permissão, garante que o servidor conhece este aparelho. */
export async function refreshPush(token: string): Promise<void> {
  if (pushState() === 'granted') await subscribe(token).catch(() => undefined);
}

export async function testPush(token: string): Promise<number> {
  const res = await api(token, 'test', {});
  return ((await res.json()) as { sent: number }).sent;
}
