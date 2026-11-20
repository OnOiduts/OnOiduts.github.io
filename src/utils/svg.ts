/**
 * 内联 SVG 的规范化处理。
 *
 * 问题：本地 SVG 常带写死的 width/height（比如 width="800"），
 * 或有 width/height 但没有 viewBox —— 这两种情况下 CSS 的
 * width:100% 都不生效/不缩放，图形会按原始像素尺寸渲染，直接撑爆容器。
 *
 * 解决办法（在服务端把原始字符串改好再 set:html）：
 *   1. 没有 viewBox → 用 width/height 的数值推断一个，让缩放有依据
 *   2. 补 preserveAspectRatio="xMidYMid meet" → 等比缩放、居中，绝不变形
 *   3. 去掉写死的 width/height 属性 → 尺寸完全交给外层容器
 */
export function normalizeSvg(raw: string): string {
  const src = raw.trim();
  const open = src.match(/<svg\b[^>]*>/i);
  if (!open) return src;

  let tag = open[0];

  // 1) 补 viewBox
  if (!/\bviewBox\s*=/i.test(tag)) {
    const w = tag.match(/\bwidth\s*=\s*["']?([\d.]+)/i)?.[1];
    const h = tag.match(/\bheight\s*=\s*["']?([\d.]+)/i)?.[1];
    if (w && h && Number(w) > 0 && Number(h) > 0) {
      tag = tag.replace(/<svg\b/i, `<svg viewBox="0 0 ${strip(w)} ${strip(h)}"`);
    }
  }

  // 2) 补等比缩放策略
  if (!/\bpreserveAspectRatio\s*=/i.test(tag)) {
    tag = tag.replace(/<svg\b/i, '<svg preserveAspectRatio="xMidYMid meet"');
  }

  // 3) 去掉写死的宽高（去掉后尺寸由外层容器 + CSS 决定）
  tag = tag.replace(/\s(?:width|height)\s*=\s*["'][^"']*["']/gi, '');
  tag = tag.replace(/\s(?:width|height)\s*=\s*[\d.]+/gi, '');

  // 4) 打标记，方便客户端兜底逻辑找到这些内联 svg
  const cls = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
  if (cls) {
    if (!/inline-svg/.test(cls[1])) tag = tag.replace(/\bclass\s*=\s*["'][^"']*["']/i, `class="${cls[1]} inline-svg"`);
  } else {
    tag = tag.replace(/<svg\b/i, '<svg class="inline-svg"');
  }

  // 5) 去掉 XML 声明 / DOCTYPE / 生成器注释：内联进 HTML 时它们没有意义，
  //    而且注释出现在 <svg> 之前会导致片段解析异常。
  const cleaned = src
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/^\s*<!--[\s\S]*?-->/, '')
    .trim();

  return cleaned.replace(open[0], tag);
}

function strip(v: string): string {
  // 去掉 px / pt 之类的单位，只留数字
  return v.replace(/[^\d.]/g, '');
}
