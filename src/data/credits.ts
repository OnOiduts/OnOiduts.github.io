/**
 * 「网站搭建」板块：演职人员表（credits roll）的数据。
 *
 * 单列排布、居中。每项 = 角色 + 内容：
 *   - 内容按段拆分，带 url 的段渲染成可点的链接（强调色 + 加粗、新窗口）
 *   - 没 url 的段就是普通文字（比如「代码」里版本号不点）
 *   - worldV 的项（目前只有「构思」）会跟世界变，由 CSS 按 data-world 切换
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

const LIYE = 'https://www.taobao.com/list/item/NFh2RU4xZGd1MWw2UzJPNEJrazZndz09.htm';

export const credits: CreditItem[] = [
  { k: '框架', v: [{ text: 'Astro', url: 'https://astro.build' }] },
  { k: '语言', v: [{ text: 'TypeScript', url: 'https://www.typescriptlang.org' }] },
  { k: '样式', v: [{ text: '纯 CSS 变量' }] },
  { k: '动效', v: [{ text: '原生 JS + CSS' }] },
  { k: '交互组件', v: [{ text: 'React', url: 'https://react.dev' }] },
  {
    k: '状态管理',
    v: [{ text: 'nanostores', url: 'https://github.com/nanostores/nanostores' }],
  },
  { k: '内容', v: [{ text: 'Markdown + frontmatter' }] },
  { k: '部署', v: [{ text: 'GitHub Pages', url: 'https://pages.github.com' }] },
  {
    k: '字体',
    v: [
      { text: '狸叶黑体', url: LIYE },
      { text: ' / ' },
      { text: 'JetBrains Mono', url: 'https://www.jetbrains.com/lp/mono/' },
      { text: ' / ' },
      { text: 'Inter', url: 'https://rsms.me/inter/' },
      { text: ' / ' },
      { text: '思源黑体', url: 'https://github.com/adobe-fonts/source-han-sans' },
    ],
  },
  {
    k: '构思',
    worldV: { org: 'OnOiduts工业', buono: '波萝Buono', zilan: '孜岚' },
  },
  { k: '整理', v: [{ text: 'DeepSeek', url: 'https://www.deepseek.com' }] },
  {
    k: '代码',
    v: [{ text: '腾讯元宝', url: 'https://yuanbao.tencent.com' }, { text: ' Hy4 Preview' }],
  },
];
