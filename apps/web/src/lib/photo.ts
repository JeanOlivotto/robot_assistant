/** Fotos do chat: reduzir no celular antes de subir, enviar e buscar para mostrar. */
import { useEffect, useState } from 'react';
import { cabecalhosDeOnde } from './origem';

const MAX_SIDE = 1280; /* o bastante para ler texto numa foto; sobe rápido no 4G */
const QUALITY = 0.85;

export interface ReadyPhoto {
  blob: Blob;
  w: number;
  h: number;
  /** Para mostrar a prévia antes de enviar (revogar depois). */
  url: string;
}

/** Lê a foto escolhida (já na orientação certa) e reduz para JPEG de até 1280 px. */
export async function preparePhoto(file: File): Promise<ReadyPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const source = bitmap ?? (await loadImage(file));
  const sw = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const sh = 'naturalHeight' in source ? source.naturalHeight : source.height;
  const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const w = Math.round(sw * k);
  const h = Math.round(sh * k);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(source, 0, 0, w, h);
  bitmap?.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('não consegui preparar a foto'))), 'image/jpeg', QUALITY),
  );
  return { blob, w, h, url: URL.createObjectURL(blob) };
}

/** Navegador sem createImageBitmap para esse arquivo: carrega por <img>. */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('este arquivo não parece ser uma foto'));
    img.src = URL.createObjectURL(file);
  });
}

export async function sendPhoto(token: string, p: ReadyPhoto, caption: string): Promise<void> {
  const q = new URLSearchParams({ w: String(p.w), h: String(p.h), caption });
  const res = await fetch(`/api/chat/photo?${q}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', ...cabecalhosDeOnde() },
    body: p.blob,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `erro ${res.status}`);
  }
}

/* A foto pede a senha no cabeçalho, então <img src> direto não serve: busca como blob e guarda. */
const cache = new Map<string, Promise<string>>();

export function usePhotoUrl(token: string, id: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let p = cache.get(id);
    if (!p) {
      p = fetch(`/api/chat/photo/${id}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob().then((b) => URL.createObjectURL(b));
      });
      p.catch(() => cache.delete(id)); // falhou: deixa tentar de novo depois
      cache.set(id, p);
    }
    p.then((u) => alive && setUrl(u)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [token, id]);
  return url;
}
