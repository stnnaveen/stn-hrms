// Offline queue (PRD LC-07): a check-in made without signal is stored with its time and sent later.
// The server flags anything synced more than 30 minutes late.
import { get, set } from 'idb-keyval';

export interface QueuedPunch {
  idempotency_key: string;
  kind: 'in' | 'out' | 'visit';
  client_time: string;
  selfie: Blob;
  location: { lat: number; lng: number; accuracy: number | null; altitude: number | null; speed: number | null; mocked: boolean | null };
  liveness: { challenge: string; passed: boolean };
  timings?: { gps_wait_ms?: number; capture_ms?: number; before_send_ms?: number };
  leave_for_od?: string | null;
}

const KEY = 'stn-punch-queue';

export async function enqueue(p: QueuedPunch) {
  const q = (await get<QueuedPunch[]>(KEY)) ?? [];
  if (!q.some((x) => x.idempotency_key === p.idempotency_key)) q.push(p);
  await set(KEY, q);
}

export async function pending(): Promise<QueuedPunch[]> {
  return (await get<QueuedPunch[]>(KEY)) ?? [];
}

export async function remove(key: string) {
  const q = (await get<QueuedPunch[]>(KEY)) ?? [];
  await set(KEY, q.filter((x) => x.idempotency_key !== key));
}
