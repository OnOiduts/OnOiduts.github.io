/**
 * remark 插件：识别 `:::text` 容器指令，给一段文字加
 * 「字号 / 文字颜色 / 纯色描边 / 渐变填充 / 单回车换行」。
 *
 * 用法：
 *
 *   :::text{size="xl" color="#fff" stroke="#000" sw="1" grad="#ff5f6d,#ffc371" dir="90deg"}
 *   这一行
 *   紧跟着这一行
 *
 *   空一行才另起一段
 *   :::
 *
 * 属性（全部可选，不写就用站点默认）：
 *   size    xs | sm | md | lg | xl | xxl   档位，或 CSS 长度（如 20px / 1.4em）
 *           ⚠️ 档位映射到 --fs-* 变量，窄屏会自动跟着全站标题一起回缩；
 *              写死 px 不会缩，所以工具条只给档位。
 *   color   文字颜色：#hex / rgb() / hsl() / var(--xxx) / 英文颜色名
 *   stroke  描边颜色（同上），只支持纯色 —— CSS 的 -webkit-text-stroke
 *           不接受渐变，这是硬限制。
 *   sw      描边宽度（px）。小字号会自动压细，见 SW_CAP。
 *   grad    渐变填充的色标，用英文逗号分隔，2~4 个颜色。
 *   dir     渐变方向，如 90deg / 135deg / to right。默认 90deg。
 *   br      单回车是否断行：1（默认，只断行不另起一段）/ 0（按 Markdown 原样）
 *
 * 实现要点：
 *  - 产出 mdast 的 `html` 节点，Astro 直接输出，不会被转义。
 *  - 「描边 + 渐变」在 CSS 里是冲突的：渐变要把文字填充设成透明，描边要画轮廓。
 *    所以用**双层 DOM**：下面一层只画描边、上面一层画渐变，grid 叠在同一格。
 *    没有渐变时退成单层，直接 color + -webkit-text-stroke，不多余造节点。
 *  - 所有属性都要过白名单才写进 style —— 它们最终会进 HTML 属性，
 *    绝不能让 url() / expression() / 分号 / 引号漏进去。
 *  - 站内 --accent / --text 等变量只在带 data-theme / data-world 的页面上有效，
 *    所以 CSS 里每个变量都给了 var(--ts-x, 回退值) 兜底。
 *
 * ⚠️ 指令名必须小写匹配：remark-directive 保留原始大小写，`:::Text` 不命中。
 * ⚠️ 容器里请只放文字和行内标记（粗体 / 斜体 / 链接 / 行内码）。
 *    双层模式会把内容复制两份，图片、脚注、播放器等块级内容不要放进来。
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
   任何含 ; { } " ' < > \ 或 url( 的一律丢弃，回退到默认值。 */
const SAFE = (v) => typeof v === 'string'
  && !/[;{}"'<>\\]/.test(v)      // 分号 / 花括号 / 引号 / 尖括号 / 反斜杠
  && !String(v).includes('/')   // 斜杠（挡 rgba(… / .5) 这类写法，也挡路径）
  && !/url\s*\(/i.test(v);      // url() 一律不许进 style
/* ⚠️ 不能把 `)` 列入禁用字符：COLOR 里专门写了 rgb()/hsl() 分支，
   禁了 `)` 这个分支就永远不可达。去掉它无害 —— url( 单独拦，
   其余危险字符仍在，自定义属性值里的括号不会闭合 HTML 属性。 */
const COLOR = (v) => {
  if (!SAFE(v)) return null;
  const s = v.trim();
  if (/^#[\da-f]{3,8}$/i.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[\d.\s,%/]+\s*\)$/i.test(s)) return s;
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

  /* 渐变色标：拆英文逗号，逐个过颜色白名单，2~4 个才认 */
  /* 色标按「括号外的逗号」拆：rgb(255,0,0) 自己带逗号，
     直接 split(',') 会把它切成 rgb(255 / 0 / 0) 三段，渐变静默失效。 */
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
  let grad = null;
  if (a.grad) {
    const stops = splitStops(a.grad).map((x) => COLOR(x.trim())).filter(Boolean);
    if (stops.length >= 2 && stops.length <= 4) {
      /* ⚠️ 先算候选值再用：早先写成 has(String(a.dir ?? '90deg')...) ? String(a.dir)... : '90deg'，
         三元两分支取值不一致，没写 dir 时后半段拿到 String(undefined) → 'undefined'，
         拼出 linear-gradient(undefined,#f00,#0f0)，整条 background 声明被浏览器判为无效。 */
      const d = String(a.dir ?? '90deg').trim().toLowerCase();
      const dir = DIRS.has(d) ? d : '90deg';
      grad = `linear-gradient(${dir},${stops.join(',')})`;
    }
  }
  /* br 默认 1：容器里敲一个回车就断行，但**不**另起一段（空行才分段） */
  const br = !/^(0|false|no|off)$/i.test(String(a.br ?? '1').trim());
  return { size, color, stroke, sw, grad, br, hasStroke: !!stroke && sw !== '0' };
}

/* mdast → HTML。只处理容器里会出现的行内 / 段落节点，够用且零依赖
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

export default function remarkTextStyle() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (node.type !== 'containerDirective' || node.name !== 'text') return;
      if (!parent) return;

      const p = parseAttrs(node.attributes || {});
      const inner = (node.children || []).map((c) => nodeHtml(c, p.br)).join('');
      if (!inner.trim()) {           // 空容器直接移除，别留个空壳
        parent.children.splice(index, 1);
        return [SKIP, index];
      }

      const cls = ['ts-wrap', p.hasStroke ? 'has-stroke' : '', p.grad ? 'has-grad' : '']
        .filter(Boolean).join(' ');
      /* 顺序固定，写作台预览按同一顺序拼，两边字符串才能逐字对上 */
      const style = [
        `--ts-size:${p.size}`,
        `--ts-color:${p.color}`,
        `--ts-stroke:${p.stroke || 'transparent'}`,
        `--ts-sw:${p.sw}px`,
        `--ts-grad:${p.grad || 'none'}`,
      ].join(';');

      const html = p.grad
        ? `<div class="${cls}" style="${esc(style)}">`
          + `<div class="ts-stroke" aria-hidden="true">${inner}</div>`
          + `<div class="ts-fill">${inner}</div></div>`
        : `<div class="${cls}" style="${esc(style)}">`
          + `<div class="ts-fill">${inner}</div></div>`;

      parent.children[index] = { type: 'html', value: html };
      return [SKIP, index];
    });
  };
}

/* 供测试/写作台一致性校验复用：把一段属性对象转成最终 HTML 片段。
   写作台里的实现是这份逻辑的手写镜像，两边输出必须逐字相同。 */
export { parseAttrs, nodeHtml };
