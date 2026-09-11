// messageTime.ts — 消息时间显示的智能格式化（今天只显示时分，跨天带日期）

export function formatMessageTime(
  timestamp: number,
  now: number = Date.now(),
  yesterdayLabel: string = "昨天"
): string {
  const d = new Date(timestamp);
  const n = new Date(now);
  const pad = (x: number) => String(x).padStart(2, "0");
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (sameDay(d, n)) return hhmm;
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (sameDay(d, yesterday)) return `${yesterdayLabel} ${hhmm}`;
  if (d.getFullYear() === n.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
}
