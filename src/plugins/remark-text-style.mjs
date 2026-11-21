/**
 * remark 插件（三合一，一份实现管三件事）：
 *
 *   1. `:::text{...}` 容器 —— 整段文字的字号 / 颜色 / 纯色描边 / 渐变填充
 *   2. `:text[几个字]{...}` 行内 —— 选中几个字直接改颜色 / 字号（快捷按钮用）
 *   3. 全站软换行 —— 正文段落里敲一个回车就断行，空一行才另起一段
 *
 * 为什么合在一个文件：三件事共用同一套颜色 / 字号白名单与解析逻辑，
 * 拆开就会漂移。而且顺序天然正确 —— 先把容器 / 行内指令换成 html 节点，
 * 再遍历剩余 paragraph 补 <br>，容器内部不会被二次处理。
 *
 * ── 用法 ──────────────────────────────────────────────────
 *
 * 行内（写作台「字色 / 放大 / 缩小」按钮自动生成，日常不用手写）：
 *   :text[这几个字]{color="#ff5f6d" size="xl"}
 *
 * 容器（渐变 + 描边这类块级效果，写作台「文字样式」弹窗生成）：
 *   :::text{size="xl" color="#fff" stroke="#000" sw="1" grad="#ff5f6d,#ffc371"}
 *   第一行
 *   第二行
 *
 *   空一行才另起一段
 *   :::
 *
 * 属性（全部可选，不写就用站点默认）：
 *   size    xs | sm | md | lg | xl | xxl   档位，或 CSS 长度（如 20px / 1.4em）
 *           ⚠️ 档位映射到 --fs-* 变量，窄屏会跟着全站标题一起回缩；
 *              写死 px 不会缩，所以工具条只给档位。
 *   color   文字颜色：#hex / rgb() / hsl() / var(--xxx) / 英文颜色名
 *   stroke  描边颜色（同上），只支持纯色 —— CSS 的 -webkit-text-stroke
 *           不接受渐变，这是硬限制。
 *   sw      描边宽度（px）。小字号会自动压细，见 SW_CAP。
 *   grad    渐变填充色标，2~4 个颜色，英文逗号分隔（rgb() 自带逗号也认）。
 *   dir     渐变方向，如 90deg / 135deg / to right。默认 90deg。
 *   br      「这段偏不要换行」：只有容器认。
 *           默认 1 / 不写 → 跟全站一致（单回车断行）；
 *           写 br="0" → 这段回到 Markdown 原样，单回车不算换行。
 *
 * ── 实现要点 ──────────────────────────────────────────────
 *  - 产出 mdast 的 `html` 节点，Astro 直接输出，不会被转义。
 *  - 「描边 + 渐变」在 CSS 里冲突：渐变要把文字填充设成透明，描边要画轮廓。
 *    所以用**双层 DOM**：下面一层只画描边、上面一层画渐变，grid 叠在同一格。
 *    没有渐变时退成单层，不多造节点。行内指令不走双层（基线 / 读屏会出问题）。
 *  - 所有属性都要过白名单才写进 style —— 它们最终会进 HTML 属性，
 *    绝不能让 url() / 分号 / 引号 / 花括号漏进去。
 *  - 站内 --accent / --text 等变量只在带 data-theme / data-world 的页面上有效，
 *    CSS 里每个变量都给了 var(--ts-x, 回退值) 兜底。
 *  - 全站软换行**不引 remark-breaks**：这边 npm install 长期装不齐依赖，
 *    少一个包少一处风险。只把 paragraph 里 text 节点的 \n 拆成 break 节点，
 *    代码块 / 表格 / 列表 / frontmatter 一概不碰（列表项内部也跳过）。
 *
 * ⚠️ 指令名必须小写匹配：remark-directive 保留原始大小写，`:::Text` 不命中。
 * ⚠️ 容器里请只放文字和行内标记。双层模式会复制内容两份，
 *    图片、脚注、播放器等块级内容不要放进来。
 */
import { visit, SKIP } from 'unist-util-visit';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/* ── 输入白名单 ────────────────────────────────────────────────
   属性会拼进 style="..." 和 class，只放行「长得就像颜色 / 长度」的值。
   分号 / 花括号 / 引号 / 尖括号 / 反斜杠 / 斜杠 / url( 一律丢弃，回退默认值。
   ⚠️ 不能把 `)` 列入禁用字符：COLOR 里专门写了 rgb()/hsl() 分支，
      禁了 `)` 这个分支就永远不可达。 */
const SAFE = (v) => typeof v === 'string'
  && !/[;{}"'<>\\]/.test(v)
  && !String(v).includes('/')
  && !/url\s*\(/i.test(v);
const COLOR = (v) => {
  if (!SAFE(v)) return null;
  const s = v.trim();
  if (/^#[\da-f]{3,8}$/i.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[\d.\s,%]+\s*\)$/i.test(s)) return s;
  if (/^var\(\s*--[\w-]+\s*\)$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s;   // red / transparent / currentColor…
  return null;
};
const LEN = (v) => (SAFE(v) && /^\d+(?:\.\d+)?(?:px|em|rem|%)$/.test(v.trim()) ? v.trim() : null);

/* 档位 → 站点字号变量。刻意用 var()，窄屏回缩自动生效 */
const SIZES = {
  xs: 'var(--fs-xs)', sm: 'var(--fs-sm)', md: 'var(--fs-body)',
  lg: 'var(--fs-h3)', xl: 'var(--fs-h2)', xxl: 'var(--fs-h1)',
};
/* 小字号配粗描边会糊掉字腔：按档位压上限（单位 px）。
   自由长度值统一按 md 档处理，不猜它实际多大。 */
const SW_CAP = { xs: 0.6, sm: 0.8, md: 1.2, lg: 2, xl: 2.6, xxl: 3 };

const DIRS = new Set([
  '0deg', '45deg', '90deg', '135deg', '180deg', '225deg', '270deg', '315deg',
  'to right', 'to left', 'to bottom', 'to top',
  'to right bottom', 'to left bottom', 'to right top', 'to left top',
]);

/* 色标按「括号外的逗号」拆：rgb(255,0,0) 自己带逗号，
   直接 split(',') 会把它切成三段，渐变静默失效。 */
const splitStops = (s) => {
  const out = []; let depth = 0, cur = '';
  for (const ch of String(s)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
};

function parseAttrs(a = {}) {
  const sizeKey = String(a.size ?? 'md').trim().toLowerCase();
  const size = SIZES[sizeKey] || LEN(a.size) || SIZES.md;
  const cap = SW_CAP[sizeKey] ?? SW_CAP.md;

  const color = COLOR(a.color) || 'var(--text)';
  const stroke = COLOR(a.stroke);
  const swRaw = Number(a.sw);
  const sw = stroke && Number.isFinite(swRaw) && swRaw > 0
    ? Math.min(swRaw, cap).toFixed(2).replace(/\.00$/, '')
    : '0';

  let grad = null;
  if (a.grad) {
    const stops = splitStops(a.grad).map((x) => COLOR(x.trim())).filter(Boolean);
    if (stops.length >= 2 && stops.length <= 4) {
      /* ⚠️ 先算候选值再用：早先三元两分支取值不一致，没写 dir 时
         后半段拿到 String(undefined) → 拼出 linear-gradient(undefined,...)，
         整条 background 声明被浏览器判为无效。 */
      const d = String(a.dir ?? '90deg').trim().toLowerCase();
      const dir = DIRS.has(d) ? d : '90deg';
      grad = `linear-gradient(${dir},${stops.join(',')})`;
    }
  }
  /* 容器默认跟全站一致：单回车断行。br="0" 是「这段偏不要换行」的开关。 */
  const br = !/^(0|false|no|off)$/i.test(String(a.br ?? '1').trim());
  return { size, color, stroke, sw, grad, br, hasStroke: !!stroke && sw !== '0' };
}

/* mdast → HTML。只处理容器 / 行内指令里会出现的行内节点，够用且零依赖
   （不引 mdast-util-to-hast，免得 CI 装包时空缺一个传递依赖）。 */
function nodeHtml(n, br) {
  if (!n) return '';
  switch (n.type) {
    case 'text': {
      const t = esc(n.value);
      return br ? t.replace(/\n/g, '<br>') : t.replace(/\n/g, ' ');
    }
    case 'break': return '<br>';
    case 'paragraph': return `<p>${(n.children || []).map((c) => nodeHtml(c, br)).join('')}</p>`;
    case 'strong': return `<strong>${(n.children || []).map((c) => nodeHtml(c, br)).join('')}</strong>`;
    case 'emphasis': return `<em>${(n.children || []).map((c) => nodeHtml(c, br)).join('')}</em>`;
    case 'delete': return `<del>${(n.children || []).map((c) => nodeHtml(c, br)).join('')}</del>`;
    case 'inlineCode': return `<code>${esc(n.value)}</code>`;
    case 'link': {
      const href = esc(String(n.url ?? ''));
      const title = n.title ? ` title="${esc(n.title)}"` : '';
      return `<a href="${href}"${title}>${(n.children || []).map((c) => nodeHtml(c, br)).join('')}</a>`;
    }
    case 'heading': {
      const lv = Math.min(Math.max(n.depth || 3, 1), 6);
      return `<h${lv}>${(n.children || []).map((c) => nodeHtml(c, br)).join('')}</h${lv}>`;
    }
    case 'blockquote': return `<blockquote>${(n.children || []).map((c) => nodeHtml(c, br)).join('')}</blockquote>`;
    case 'thematicBreak': return '<hr>';
    case 'html': return String(n.value ?? '');
    default: return (n.children || []).map((c) => nodeHtml(c, br)).join('');
  }
}

/* 行内快捷：只给颜色 / 字号。描边与渐变的双层 DOM 不适合塞进句子中间
   —— 基线对齐、链接能不能点、读屏会不会把同一句念两遍都成问题。 */
function inlineStyleHtml(node) {
  const p = parseAttrs(node.attributes || {});
  const inner = (node.children || []).map((c) => nodeHtml(c, false)).join('');
  /* 顺序固定，写作台预览按同一顺序拼，两边字符串才能逐字对上 */
  const style = `--ts-size:${p.size};--ts-color:${p.color}`;
  return `<span class="ts-inline" style="${esc(style)}">${inner}</span>`;
}

function containerHtml(node) {
  const p = parseAttrs(node.attributes || {});
  const inner = (node.children || []).map((c) => nodeHtml(c, p.br)).join('');
  if (!inner.trim()) return null;

  const cls = ['ts-wrap', p.hasStroke ? 'has-stroke' : '', p.grad ? 'has-grad' : '']
    .filter(Boolean).join(' ');
  /* 顺序固定，写作台预览按同一顺序拼 */
  const style = [
    `--ts-size:${p.size}`,
    `--ts-color:${p.color}`,
    `--ts-stroke:${p.stroke || 'transparent'}`,
    `--ts-sw:${p.sw}px`,
    `--ts-grad:${p.grad || 'none'}`,
  ].join(';');

  return p.grad
    ? `<div class="${cls}" style="${esc(style)}">`
      + `<div class="ts-stroke" aria-hidden="true">${inner}</div>`
      + `<div class="ts-fill">${inner}</div></div>`
    : `<div class="${cls}" style="${esc(style)}">`
      + `<div class="ts-fill">${inner}</div></div>`;
}

/* ── 全站软换行 ──────────────────────────────────────────────
   remark-parse 把段落里的单个回车留在 text 节点的 \n 里，空行则切成两个
   paragraph。所以只要把 \n 拆成 break 节点，rehype 就会输出 <br>。

   ⚠️ 必须递归进行内节点（strong / em / link…）：`**粗\n体**` 的真实 mdast 是
      strong(text('粗\n体'))，只扫 paragraph 的直接子节点会漏掉它，
      结果「粗体跨行不断、旁边的普通字却断」，两边不一致。

   边界用「哪些块级明确关掉」来定，而不是「哪些节点允许」——
   引用块的多行续行、列表续行、代码块 / 表格 / frontmatter / 裸 HTML
   都保持老规矩；标题、脚注定义也不该凭空断行。
   只有普通 paragraph 及其行内后代才激活。 */
const BREAK_OFF = new Set([
  'list', 'listItem', 'code', 'inlineCode', 'yaml',
  'table', 'tableRow', 'tableCell', 'blockquote',
  'heading', 'thematicBreak', 'footnoteDefinition', 'html',
]);
function applyBreaks(node, active, forbidden) {
  const off = BREAK_OFF.has(node.type);
  const nextForbidden = forbidden || off;
  /* ⚠️ 两个状态必须分开：
     active    = 当前是否处在「普通段落（含它的行内后代）」里
     forbidden = 是否处在 list / blockquote / code 等被关掉的块里
     只用一个变量时，paragraph 会无条件把 active 打开，
     于是列表项内部、引用内部的段落也被误判成普通段落。 */
  const childActive = nextForbidden ? false : (node.type === 'paragraph' ? true : active);
  if (childActive && node.children) {
    const out = [];
    for (const c of node.children) {
      if (c.type !== 'text' || !String(c.value).includes('\n')) { out.push(c); continue; }
      const parts = String(c.value).split('\n');
      parts.forEach((v, i) => {
        if (i) out.push({ type: 'break' });
        if (v) out.push({ type: 'text', value: v });
      });
    }
    node.children = out;
  }
  for (const c of node.children || []) applyBreaks(c, childActive, nextForbidden);
}

export default function remarkTextStyle() {
  return (tree) => {
    /* 第一步：容器 / 行内指令 → html 节点。
       ⚠️ 必须在第二步之前，否则容器内的段落会被全局换行二次处理。 */
    visit(tree, (node, index, parent) => {
      if (node.type === 'containerDirective' && node.name === 'text' && parent) {
        const html = containerHtml(node);
        if (html === null) {           // 空容器直接移除，别留个空壳
          parent.children.splice(index, 1);
          return [SKIP, index];
        }
        parent.children[index] = { type: 'html', value: html };
        return [SKIP, index];
      }
      if (node.type === 'textDirective' && node.name === 'text' && parent) {
        parent.children[index] = { type: 'html', value: inlineStyleHtml(node) };
        return [SKIP, index];
      }
    });
    /* 第二步：剩下的普通段落补 <br>。此时容器已是 html 节点，看不到内部。
       root 初始 active=false，只有 paragraph 会把它打开。 */
    applyBreaks(tree, false, false);
  };
}

/* 供测试/写作台一致性校验复用 */
export { parseAttrs, nodeHtml, containerHtml, inlineStyleHtml, applyBreaks, BREAK_OFF };
