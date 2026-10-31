// Supabase returns at most 1,000 rows per request. For reports and stats over many days, fetch page by page.
import { ApiError } from './api';

// deno-lint-ignore no-explicit-any
export type Q = { range: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: unknown }> };

/** `make` must return a fresh, ordered query each time (stable order keeps pages from overlapping). */
export async function fetchAll<T>(make: () => Q, cap = 60000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw new ApiError('load_failed');
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
