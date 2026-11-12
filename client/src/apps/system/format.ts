/** How the System window writes sizes, times and shares. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** "1.4 MB", "58 GB": binary steps, three significant figures at most. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** "27.5 ms", "412 ms", "1.84 s". */
export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms < 100 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

/** The bare number over a bar; whole milliseconds when the bars are narrow. */
export function formatBarMs(ms: number, narrow: boolean): string {
  if (ms >= 100 || narrow) return String(Math.max(1, Math.round(ms)));
  return ms.toFixed(1);
}

export const formatPercent = (share: number): string => `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;

/** "3 d 4 h", "4 h 12 min", "12 min", "40 s". */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${total} s`;
}

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "Nov 11, 23:19" */
export const formatWhen = (at: number): string => WHEN.format(new Date(at));
