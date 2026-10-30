// India time helpers. Display only: the server decides bands and lateness.
export const IST = 'Asia/Kolkata';

export function istMinutesNow(d = new Date()): number {
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
}

export function fmtTime(iso: string | Date | null | undefined): string {
  if (!iso) return '--:--';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST }).toUpperCase();
}

/** "9:52" and "AM" separately, for the big numbers on the home card. */
export function splitTime(iso: string | null | undefined): [string, string] {
  if (!iso) return ['--:--', ''];
  const t = fmtTime(iso);
  const [hm, ap] = t.split(' ');
  return [hm, ap ?? ''];
}

export function fmtDay(d = new Date()): string {
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: IST });
}

export function fmtShortDay(d = new Date()): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: IST });
}

export function greeting(d = new Date()): string {
  const m = istMinutesNow(d);
  return m < 720 ? 'Good morning' : m < 1020 ? 'Good afternoon' : 'Good evening';
}

export function hoursBetween(a: string | null | undefined, b: string | null | undefined): string {
  if (!a) return '0h';
  const ms = (b ? new Date(b) : new Date()).getTime() - new Date(a).getTime();
  const min = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`.replace(' ', '');
}

export function stamp(d: Date): string {
  const day = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: IST });
  return `${day} · ${fmtTime(d)} IST`;
}
