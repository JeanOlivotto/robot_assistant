import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { Ble } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

type BleMsg = z.infer<typeof Ble>;

/** Tipo do anúncio Apple que um iPhone/iPad/Mac em uso manda o tempo todo. */
const NEARBY_INFO = 0x10;
/*
 * "Na mesa" = um iPhone apareceu forte nos últimos 5 min. Primeiros dados (24/09, dono sentado o
 * tempo todo): o iPhone dele oscila entre -43 e -48 dBm, mas some por até 4 min quando está
 * bloqueado; o que resta é -72 a -80, de outros aparelhos Apple mais longe. Mesma regra do firmware.
 */
const NEAR_RSSI = -60;
const NEAR_MS = 5 * 60_000;
const KEEP_MS = 7 * 24 * 3600_000;
const FILE_MAX_BYTES = 8 * 1024 * 1024;

/** Um minuto resumido: o que a tabela do experimento mostra. */
export interface PresenceMinute {
  /** Início do minuto (epoch ms). */
  at: number;
  /** Sinal Apple mais forte do minuto (dBm), null se nada foi ouvido. */
  best: number | null;
  /** Sinal mais forte entre os "Nearby Info" — o candidato a ser o iPhone do dono. */
  nearby: number | null;
  /** Mais aparelhos Apple distintos numa janela de 10 s. */
  devices: number;
  /** Pela regra da janela de 5 min, o dono estava na mesa neste minuto. */
  present: boolean;
}

/**
 * Experimento de presença pelo Bluetooth. O robô manda, a cada 10 s, o sinal dos aparelhos Apple
 * por perto; aqui fica o histórico, resumido por minuto, para descobrir se o sinal separa "o dono
 * está na mesa" de "saiu". Ainda não decide nada — só mede.
 */
@Injectable()
export class PresenceService {
  private readonly log = new Logger(PresenceService.name);
  private readonly file: string;
  private minutes: PresenceMinute[] = [];
  private strongAt = 0;
  private present = false;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/presenca.jsonl`);
    this.load();
  }

  record(msg: BleMsg): void {
    const now = Date.now();
    const at = now - (now % 60_000);
    const best = msg.dev.length ? Math.max(...msg.dev.map((d) => d.r)) : null;
    const nearbyList = msg.dev.filter((d) => d.k === NEARBY_INFO).map((d) => d.r);
    const nearby = nearbyList.length ? Math.max(...nearbyList) : null;

    let m = this.minutes.at(-1);
    if (!m || m.at !== at) {
      if (m) this.persist(m);
      m = { at, best: null, nearby: null, devices: 0, present: false };
      this.minutes.push(m);
      this.trim(now);
    }
    m.best = max(m.best, best);
    m.nearby = max(m.nearby, nearby);
    m.devices = Math.max(m.devices, msg.n);

    if (nearby !== null && nearby >= NEAR_RSSI) this.strongAt = now;
    const present = now - this.strongAt < NEAR_MS;
    m.present ||= present;
    // Uma linha só quando muda — o log não vira um contador de 10 em 10 s.
    if (present !== this.present) {
      this.log.log(present ? `BLE: dono chegou (iPhone a ${nearby} dBm)` : 'BLE: dono saiu (5 min sem o iPhone por perto)');
      this.present = present;
    }
  }

  /** O dono está na mesa agora (pela janela de 5 min). */
  get isPresent(): boolean {
    return this.present;
  }

  /** Os minutos das últimas `horas`, mais antigos primeiro. */
  history(horas: number): PresenceMinute[] {
    const desde = Date.now() - horas * 3600_000;
    return this.minutes.filter((m) => m.at >= desde);
  }

  private trim(now: number): void {
    const corte = now - KEEP_MS;
    while (this.minutes.length && this.minutes[0]!.at < corte) this.minutes.shift();
  }

  private persist(m: PresenceMinute): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (size(this.file) > FILE_MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${JSON.stringify(m)}\n`);
    } catch (err) {
      this.log.warn(`Falha ao salvar a presença: ${(err as Error).message}`);
    }
  }

  private load(): void {
    try {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (line.trim()) this.minutes.push(JSON.parse(line) as PresenceMinute);
      }
      this.trim(Date.now());
    } catch {
      /* primeira vez */
    }
  }
}

function max(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function size(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
