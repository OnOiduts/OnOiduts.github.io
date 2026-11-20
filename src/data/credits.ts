/**
 * 「网站搭建」板块：演职人员表（credits roll）的数据。
 *
 * 白板版：数组留空，about 页这个板块不显示任何行。
 * 想写内容，按下面注释里的格式往数组里加对象即可，界面和动画会自动接上。
 */

export interface CreditPart {
  text: string;
  url?: string;
}

export interface CreditItem {
  k: string;
  v?: CreditPart[];
  /** 跟世界变的内容：三个世界各一句 */
  worldV?: { org: string; buono: string; zilan: string };
}

/* 格式示例（白板版不启用）：
   { k: '框架', v: [{ text: 'Astro', url: 'https://astro.build' }] },
   { k: '构思', worldV: { org: '甲', buono: '乙', zilan: '丙' } },
*/
export const credits: CreditItem[] = [];
