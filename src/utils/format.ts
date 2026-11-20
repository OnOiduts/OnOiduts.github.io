/** 日期与文本格式化 */

const pad = (n: number) => String(n).padStart(2, '0');

export function fmtDate(d: string | Date): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export function fmtDateTime(d: string | Date): string {
  return `${fmtDate(d)} ${pad((typeof d === 'string' ? new Date(d) : d).getHours())}:${pad(
    (typeof d === 'string' ? new Date(d) : d).getMinutes()
  )}`;
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
