/** 日期与文本格式化 */

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 统一按北京时间显示。
 * ------------------------------------------------------------------
 * 写作台现在往 frontmatter 里写「2026-11-23T14:30:00+08:00」这种带时区
 * 的具体时刻。GitHub Actions 跑在 UTC 上，如果还用 getHours()/getDate()
 * 直接取本地，构建出来的页面会把 14:30 显示成 06:30，跨零点还会差一天。
 * 所以这里固定 Asia/Shanghai：不管 CI 在哪、访客电脑设的什么时区，
 * 看到的都跟作者填的一致。
 */
const TZ = 'Asia/Shanghai';

function shParts(d: Date): { date: string; time: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return {
    date: `${o.year}-${o.month}-${o.day}`,
    time: `${pad(Number(o.hour))}:${pad(Number(o.minute))}:${pad(Number(o.second))}`,
  };
}

/**
 * 日期显示。
 * 旧文章 frontmatter 只写「2026-11-23」→ 解析成 UTC 零点 → 仍只显示日期，
 * 零改动。新文章写了具体时刻 → UTC 时间部分非 0 → 自动补上「HH:mm:ss」。
 * 这样不用逐个组件把 fmtDate 换成 fmtDateTime，一处生效、全站一致。
 */
export function fmtDate(d: string | Date): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(x.getTime())) return String(d);
  const { date, time } = shParts(x);
  const hasClock =
    x.getUTCHours() || x.getUTCMinutes() || x.getUTCSeconds() || x.getUTCMilliseconds();
  return hasClock ? `${date} ${time}` : date;
}

/** 强制显示到秒（需要明确带时间的场合用） */
export function fmtDateTime(d: string | Date): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(x.getTime())) return String(d);
  const { date, time } = shParts(x);
  /* 纯日期没有「时刻」这个概念：UTC 零点换算成北京是早八，直接显示
     08:00:00 会让人以为真填了八点。这里给 00:00:00 更贴合直觉。 */
  const hasClock =
    x.getUTCHours() || x.getUTCMinutes() || x.getUTCSeconds() || x.getUTCMilliseconds();
  return `${date} ${hasClock ? time : '00:00:00'}`;
}

/** 拼音排序用的粗排序：中文按码点，英文按字母，够用 */
export function byPinyin(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN');
}

/** 阅读时长：按 350 字/分钟估 */
export function readMinutes(chars: number): number {
  return Math.max(1, Math.round(chars / 350));
}

/** 粗略字数统计：中文字符 + 英文单词 */
export function countChars(text: string): number {
  const cn = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const en = text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return cn + en;
}
