/** 全站通用交互：加载态、进度条、返回顶部、目录、灯箱、代码块、汉堡菜单 */
import { initWorld, setWorldQuiet, triggerB } from './world';
import { claimTransition } from './animLock';
import { initPlayers } from './videoPlayer';
import { initAudios } from './audioPlayer';
import { initAssetGuard } from './assetGuard';
import { initAssetDownload } from './assetDownload';

/**
 * 兜底：把正文里所有 `//` 开头的 iframe 补成 https://
 * ------------------------------------------------------------------
 * B 站「分享 → 嵌入代码」给的 src 是 `//player.bilibili.com/...`（协议相对）。
 * 在 https 页面下它会被当 http 请求 → Mixed Content 被拦 → 播放器一直缓冲。
 *
 * 插件构建时已经处理过，这里再兜一层，是为了照顾两种情况：
 *   ① 历史文章里已经写死的 `//`（重新构建前不会走新插件）
 *   ② 任何绕过 :::video 直接写在 HTML 里的裸 iframe
 *
 * ⚠️ 必须在 iframe 加载**之前**改：改 src 会重新触发导航，
 *    所以直接用 setAttribute 换掉，比导航后再修更干净。
 */
function fixProtocolRelativeIframes() {
  document.querySelectorAll<HTMLIFrameElement>('iframe[src^="//"]').forEach((f) => {
    f.src = 'https:' + f.getAttribute('src');
  });
}

export function initUI() {
  initWorld();
  bootSequence();
  initFeather();
  initProgress();
  initSvgViewBox();
  initBackToTop();
  initTOC();
  initLightbox();
  initGalleries();
  initNoteCaptions();
  initPlayers();
  initAudios();
  initCodeBlocks();
  initHamburger();
  inkSvgB();
  prepareBShatter();
  if (!(window as any).__bInit) {
    (window as any).__bInit = 1;
    initB();
  }
  initRandomFooter();
  initForceWorld();
  initFriendLinks();
  initCredits();
  initTooltips();
  fixProtocolRelativeIframes();
  /* ⚠️ 三者顺序不能动：
     ① initPlayers / initAudios 先把控件树建出来
     ② initAssetDownload 才能把 .asset-dl 搬进 .player-bar / 音频条 / 相册 caption
     ③ initAssetGuard 最后擦 data-src；下载按钮带 data-guard-off，会被整体放行 */
  initAssetDownload();
  initAssetGuard();
}

/**
 * 给 B 的黑色部分打上 .b-ink，让它跟着世界强调色变。
 *
 * 为什么不用 CSS 属性选择器猜：原稿可能写成 style="fill:#000"（内联样式，
 * CSS 根本盖不住）、#231f20、rgb(0,0,0)、或者不写颜色靠 <g> 继承 ——
 * 属性选择器抓不全。这里直接在渲染后量出每个元素的实际颜色再分类。
 *
 * 判据：接近纯黑（三通道都 ≤ 60）→ 墨色，变强调色；
 *       接近纯白（三通道都 ≥ 200）→ 纸色，锁死白色；
 *       其余（原稿自带的彩色）→ 不动，避免把品牌色吃成强调色。
 */
function inkSvgB() {
  const roots = document.querySelectorAll<SVGSVGElement>('.svg-b svg');

  const parse = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };

  roots.forEach((svg) => {
    // 只做一次：跑第二遍时黑色部分已经变成强调色了，再量会误判
    if (svg.dataset.inked) return;
    svg.dataset.inked = '1';

    svg.querySelectorAll<SVGElement>('*').forEach((el) => {
      const cs = getComputedStyle(el);

      const f = parse(cs.fill);
      if (f && f[3] > 0.1) {
        const [r, g, b] = f;
        if (r <= 60 && g <= 60 && b <= 60) el.classList.add('b-ink');
        else if (r >= 200 && g >= 200 && b >= 200) el.classList.add('b-paper');
      }

      const k = parse(cs.stroke);
      if (k && k[3] > 0.1) {
        const [r, g, b] = k;
        if (r <= 60 && g <= 60 && b <= 60) el.classList.add('b-ink-stroke');
        else if (r >= 200 && g >= 200 && b >= 200) el.classList.add('b-paper-stroke');
      }
    });
  });
}

/**
 * 演职人员表：内容从下往上滚动、无缝循环、可按住拖拽。
 *
 * 无缝的做法：把原始列表克隆若干份接在后面，轨道整体 translateY(-offset)；
 * offset 每达到一份内容高度就减去它 —— 因为下一份的开头正好顶上来，
 * 所以视觉上永远连续，不会「滚到底再弹回顶部」。
 *
 * 拖拽与点击的冲突：按下后移动超过阈值才判定为拖拽，此时在捕获阶段拦掉 click，
 * 避免拖完手一松就误触发链接；没移动就是普通点击，链接照常跳转。
 */
function initCredits() {
  const wrap = document.querySelector<HTMLElement>('#credits');
  const track = document.querySelector<HTMLElement>('#credits-track');
  const list = track?.querySelector<HTMLElement>('.credits-list');
  if (!wrap || !track || !list) return;

  const SPEED = 24; // px/s，中等速度：300px 的窗口约 12 秒滚完一轮
  const DRAG_THRESHOLD = 6; // 超过这个位移才算拖拽，否则算点击

  let unit = 0;          // 一份内容的高度
  let offset = 0;
  let dragging = false;
  let moved = false;
  let startY = 0;
  let startOffset = 0;
  let last = 0;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const normalize = () => {
    if (unit <= 0) return;
    offset = ((offset % unit) + unit) % unit;
  };

  /** 开场位移：让「第一行」落在可视区正中。
      可视区显示 track 的 [offset, offset+H]，第一行在 padTop 处，
      要它落在 H/2 → offset = padTop - H/2。取模保证落在 [0, unit) 内。
      padTop 取半屏高（150px）时结果正好是 0：可视区上半是列表顶部的空白，
      第一行从正中开始往下排 —— 上方干净，不会出现「尾部紧挨第一行」。
      注意别和下面拖拽用的 startOffset 变量重名。 */
  const openingOffset = () => {
    if (unit <= 0) return 0;
    const padTop = parseFloat(getComputedStyle(list).paddingTop) || 0;
    const target = padTop - wrap.clientHeight / 2;
    return (((target % unit) + unit) % unit);
  };

  /** 内容复制两份首尾相接：原件 + 1 份克隆。
      这样就够了 —— 单份内容（约 12 行）比 300px 窗口高，
      任何时刻窗口里最多只能看到一份，两份足够让「尾部淡出接回头部」无缝；
      内容万一比窗口矮，这里会按需要多复制几份兜底。 */
  const build = () => {
    track.querySelectorAll('.credits-clone').forEach((n) => n.remove());
    unit = list.offsetHeight;
    if (unit <= 0) return;
    // 开场位移可能把起点推到 unit 附近，份数要按「起点 + 一屏」来算才够长
    const need = openingOffset() + wrap.clientHeight;
    const copies = Math.max(2, Math.ceil(need / unit));
    for (let i = 1; i < copies; i++) {
      const clone = list.cloneNode(true) as HTMLElement;
      clone.classList.add('credits-clone');
      clone.setAttribute('aria-hidden', 'true');
      // 克隆体不进 tab 顺序，避免屏幕阅读器和键盘重复读到同一批链接
      clone.querySelectorAll('a').forEach((a) => a.setAttribute('tabindex', '-1'));
      track.appendChild(clone);
    }
    normalize();
  };

  /** 归零：回到开场位置（第一行居中），不保留上次的滚动位置。 */
  const reset = () => {
    offset = openingOffset();
    last = 0;
    track.style.transform = `translateY(${-offset}px)`;
  };

  build();
  // 进入页面就归零：bfcache 恢复、热重载等情况下 offset 可能不是 0
  reset();

  /* 字体晚一步加载完会改变行高 → 单份内容高度 unit 变了，
     而 offset 还是按旧 unit 算的，开场位置就会偏（实测偏 12px）。
     字体就绪后重算并把开场位置拉回正中。 */
  document.fonts?.ready.then(() => {
    build();
    reset();
  });

  /* 世界切换也归零 —— 「构思」那一项跟世界变，停在中途会出现
     「上半屏是旧世界文案、下半屏是新世界文案」的错位。
     切世界后关于页会重新渲染，这里同步把滚动拉回开头。 */
  window.addEventListener('worldchange', () => {
    build(); // 内容可能随世界变化（克隆体也要重建）
    reset();
  });

  // 从 bfcache 恢复（后退/前进）时也归零
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) {
      build();
      reset();
    }
  });

  window.addEventListener('resize', build);

  const frame = (now: number) => {
    if (!last) last = now;
    const dt = Math.min((now - last) / 1000, 0.1); // 切标签页回来时不要一下跳很远
    last = now;
    if (!dragging && !wrap.dataset.kbPause && !reduceMotion) {
      offset += SPEED * dt;
      normalize();
    }
    track.style.transform = `translateY(${-offset}px)`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  /* 不做悬停暂停 —— 想细看就按住拖着翻滚。
     但键盘 Tab 到链接时必须停：不然焦点跟着内容跑，根本没法用键盘操作。
     注意必须用 :focus-visible 区分：鼠标按下 <a> 时浏览器同样会给它焦点，
     若不加区分，拖完松开就会永久暂停，违反「松开后按原速继续」。 */
  wrap.addEventListener('focusin', (e) => {
    const el = e.target as Element | null;
    if (el?.matches?.(':focus-visible')) wrap.dataset.kbPause = '1';
  });
  wrap.addEventListener('focusout', () => { delete wrap.dataset.kbPause; });
  // ---- 拖拽 ----
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startOffset = offset;
    wrap.classList.add('is-dragging');
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // 别让浏览器把这次拖拽解释成页面滚动 / 文本选择
    e.preventDefault();
    const dy = e.clientY - startY;
    if (Math.abs(dy) > DRAG_THRESHOLD) moved = true;
    // 往下拖 = 内容跟着往下走 = offset 减小
    offset = startOffset - dy;
    normalize();
    track.style.transform = `translateY(${-offset}px)`;
  });

  /* 链接天生可原生拖拽（<a> 默认 draggable）。按住链接一拖，浏览器会启动
     「拖出链接」而不是滚动，同时发 pointercancel 把我们的拖拽打断。
     这里禁掉原生拖拽，让按住链接也能正常翻滚。 */
  wrap.addEventListener('dragstart', (e) => e.preventDefault());

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('is-dragging');
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);
  wrap.addEventListener('pointerleave', endDrag);

  // 拖拽过就别跳转：捕获阶段拦掉，链接本身不受影响
  track.addEventListener(
    'click',
    (e) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    },
    true
  );
}

/**
 * 文章详情页：进入时静默同步到文章所属世界（无动效），保证配色与作者名一致。
 * URL 仍然不变；刷新保持当前世界（同一个标签页内）。
 */
function initForceWorld() {
  const el = document.querySelector<HTMLElement>('[data-force-world]');
  const w = el?.dataset.forceWorld;
  if (!w) return;
  setWorldQuiet(w as 'org' | 'buono' | 'zilan');
}

/* ---- 加载态：Logo 呼吸，最短 0.5 秒，实际加载完成后淡出 ---- */
function bootSequence() {
  const boot = document.querySelector<HTMLElement>('#boot');
  const app = document.querySelector<HTMLElement>('#app');

  /* 板块切换（站内导航）过来的：不播加载遮罩，但要占住过渡锁 ——
     这样刚进页面这 0.6 秒里，任何世界切换 / 其它过渡的触发都会被忽略，
     保证「任何时刻只有一个动画在跑」。 */
  const skipBoot = document.documentElement.dataset.skipBoot !== undefined;
  if (skipBoot) claimTransition('page', 600);

  const finish = () => {
    if (boot?.classList.contains('done')) return;
    boot?.classList.add('done');
    app?.classList.add('ready');
    /* 网格和 HUD 是 body 的伪元素 / 固定层，不在 #app 里 ——
       它们的淡入状态挂在 <html>.app-ready 上，这里一并打开，
       三者才会统一地渐进出现，而不是「背景先亮、内容后跳」。 */
    document.documentElement.classList.add('app-ready');
    window.setTimeout(() => boot?.remove(), 450);
  };

  const minDone = new Promise<void>((r) => window.setTimeout(r, 500));
  const loaded = new Promise<void>((r) =>
    document.readyState === 'complete' ? r() : window.addEventListener('load', () => r())
  );
  // 外链 SVG 是外部图床，慢或挂掉时 load 事件永远不来 —— 兜底 2.5 秒必须放行，
  // 否则加载遮罩会一直盖住整站。
  const cap = new Promise<void>((r) => window.setTimeout(r, 2500));

  Promise.all([minDone, Promise.race([loaded, cap])]).then(finish);
}

/* ---- 内容区左右羽化：精确铺到屏幕边缘 ----
   ⚠️ 本轮要求：羽化要从**内容区边缘**一直渐变到**屏幕边缘**（那里完全透明），
   覆盖中间整个留白。

   为什么必须用 JS 算：单侧留白 = (可视宽 − 内容区宽) / 2，它随视口连续变化，
   CSS 里只能写成 min(170px, 12vw) 这种近似 —— 1440 视口下留白 180px 而 12vw 只有
   172.8px，最外侧 7px 没有背景覆盖，网格会整条透出来。

   ⚠️ 同时必须 clamp：::before 是靠 left/right 负值**向外撑**的，
   一旦 gx 超过真实留白，块就会伸到视口外，把文档撑宽出横向滚动条
   （这个坑之前踩过）。所以取 min(留白, ...)，并向下取整。 */
function initFeather(): void {
  const apply = () => {
    const el = document.querySelector<HTMLElement>('.container.page');
    if (!el) return;
    const r = el.getBoundingClientRect();
    /* clientWidth 不含滚动条；配合 scrollbar-gutter: stable 它稳定不变 */
    const gutter = Math.max(0, Math.floor(Math.min(r.left, document.documentElement.clientWidth - r.right)));
    if (gutter > 0) document.documentElement.style.setProperty('--glass-feather-x', `${gutter}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  /* 字体加载完内容区宽度可能变，重算一次 */
  document.fonts?.ready.then(apply);
}

/* ⚠️ 本轮：卡片的进场动画**整个去掉** —— 原来这里是 initReveal()
   （IntersectionObserver 让 .reveal 元素逐个淡入），连同 .reveal 的 CSS
   和「世界切换时抑制进场」的逻辑一并删除。卡片现在直接显示。 */
/* ---- 阅读进度条（3px，贴导航栏下） ---- */
function initProgress() {
  const bar = document.querySelector<HTMLElement>('#progress');
  if (!bar) return;
  const update = () => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = h > 0 ? `${Math.min(100, (window.scrollY / h) * 100)}%` : '0';
  };
  update();
  window.addEventListener('scroll', update, { passive: true });
}

/* ---- 返回顶部：滚动 300px 后出现 ---- */
/**
 * 兜底：给缺少 viewBox 的内联 SVG 补一个。
 * 服务端已能用 width/height 推断出 viewBox（覆盖绝大多数情况）；
 * 但万一原稿连 width/height 都没有，服务端无从推断，
 * 这里在渲染后用 getBBox() 量出实际内容范围再补上 —— 否则图形会按原始
 * 坐标绘制、不缩放，看起来就是「尺寸爆炸 / 只露出左上角」。
 */
function initSvgViewBox() {
  const fix = () => {
    document.querySelectorAll<SVGSVGElement>('svg.inline-svg').forEach((svg) => {
      if (svg.getAttribute('viewBox')) return;
      try {
        const b = svg.getBBox();
        if (b.width > 0 && b.height > 0) {
          svg.setAttribute('viewBox', `${b.x} ${b.y} ${b.width} ${b.height}`);
        }
      } catch {
        /* 元素不可见时 getBBox 会抛错，忽略即可 */
      }
    });
  };
  fix();
  // 世界切换会重新渲染关于页的层，再补一次
  window.addEventListener('worldchange', () => window.setTimeout(fix, 60));
}

function initBackToTop() {
  const btn = document.querySelector<HTMLButtonElement>('#to-top');
  if (!btn) return;
  const update = () => btn.classList.toggle('show', window.scrollY > 300);
  update();
  window.addEventListener('scroll', update, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

/* ---- 目录：点击跳转 + 段落居中 + 临时高亮 1 秒；滚动同步 ---- */

/** 与 github-slugger 同风格：空白 → 连字符，只留字母 / 数字 / 中文 / _ -。
    Astro 给 Markdown 标题生成的 slug 就是这个形状，两边才对得上。 */
function tocSlug(text: string): string {
  return text.trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '') || 'section';
}

/**
 * 把「正文里直接写的 <h2>/<h3>」补进目录。
 * ------------------------------------------------------------------
 * Astro 的 render(entry).headings 只收 Markdown 的 `## 标题`（mdast heading
 * 节点）。裸写的 <h2>…</h2> 是 mdast 的 html 节点，Astro 不会把它算进来 ——
 * 于是纯 HTML 标题的文章连目录都不渲染，混写的文章也会漏掉那几条。
 *
 * 这里在渲染后按 DOM 实际顺序重建目录：给没 id 的 HTML 标题补 id，复用
 * 服务端已渲染的 <a>（不改它们的 href），缺的补建，再按 h2 分组重排。
 * TOC.astro 在没有 Markdown H2 时渲染的是带 .toc-pending 的空壳，扫到
 * 真正的 H2 后才放出来，所以「没有 H2 就不显示目录」这条老规矩仍然成立。
 */
function buildDynamicTOC(toc: HTMLElement) {
  const prose =
    document.querySelector<HTMLElement>('.article .prose') ??
    document.querySelector<HTMLElement>('.prose');
  if (!prose) return;
  /* 排除播放器 / 相册 / 文字样式容器 / 代码块 / 脚注里可能出现的装饰性标题，
     只收正文真正的章节标题。 */
  const heads = Array.from(prose.querySelectorAll<HTMLElement>('h2, h3')).filter(
    (h) => !h.closest('.ts-wrap, .gallery, .player, .code-block, .footnotes')
  );
  if (!heads.length) return; // 一个标题都没有：原样保留服务端目录
  const hasH2 = heads.some((h) => h.tagName === 'H2');

  /* ① 只给没 id 的补 id。重复 initUI() 也不会改掉已有 id（幂等）。 */
  const used = new Set(Array.from(document.querySelectorAll('[id]'), (e) => e.id));
  heads.forEach((h) => {
    if (h.id) return;
    const base = tocSlug(h.textContent ?? '');
    let id = base,
      n = 1;
    while (used.has(id)) id = `${base}-${n++}`;
    h.id = id;
    used.add(id);
  });

  /* ② 复用服务端已渲染的 <a>（不改它们的 href），只补缺的。
        纯 Markdown 文章重排后与原来逐字一致，行为零变化。 */
  const existing = new Map<string, HTMLAnchorElement>();
  toc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    existing.set(decodeURIComponent(a.getAttribute('href')!.slice(1)), a);
  });
  const linkFor = (h: HTMLElement): HTMLAnchorElement => {
    const hit = existing.get(h.id);
    if (hit) return hit;
    const a = document.createElement('a');
    /* 新建的链接编码后再写进 href，中文 / 空格 / 括号都安全；
       点击处 decodeURIComponent 会把 id 还原回来。 */
    a.href = `#${encodeURIComponent(h.id)}`;
    a.textContent = (h.textContent ?? '').trim();
    if (h.tagName === 'H3') a.className = 'h3';
    return a;
  };

  /* ③ 按 DOM 顺序重排：H2 起一组，H3 跟在最近的 H2 后面。 */
  const groups: HTMLDivElement[] = [];
  let current: HTMLDivElement | null = null;
  heads.forEach((h) => {
    if (h.tagName === 'H2' || !current) {
      current = document.createElement('div');
      groups.push(current);
    }
    current.appendChild(linkFor(h));
  });
  Array.from(toc.children).forEach((n) => {
    if (!n.classList.contains('toc-title')) n.remove();
  });
  groups.forEach((g) => toc.appendChild(g));

  /* ④ 只有真有 H2 才放出来（沿用「有 H2 才显示目录」的老规矩） */
  if (hasH2) {
    toc.classList.remove('toc-pending');
    document.querySelector<HTMLElement>('#toc-toggle')?.classList.remove('toc-pending');
  }
}

/* 模块级：重复 initUI()（View Transitions / 切世界）时先断开旧的观察器，
   免得同一个标题被观察两遍、高亮来回跳。 */
let tocObserver: IntersectionObserver | null = null;

function initTOC() {
  const toc = document.querySelector<HTMLElement>('#toc');
  if (!toc) return;
  buildDynamicTOC(toc);
  const toggle = document.querySelector<HTMLButtonElement>('#toc-toggle');
  /* ⚠️ 目录要两个类才显示：
       .mobile-open = 「进入移动端模式」（display:block + fixed 定位）
       .open        = 「滑出来」（transform 归零）
     以前只切 .open，而窄屏下 .toc 是 display:none —— 点了完全没反应。
     这里按 matchMedia 维护 .mobile-open，窗口宽度变化时也跟着切。 */
  const mqMobile = window.matchMedia('(max-width: 900px)');
  const syncMobile = () => toc.classList.toggle('mobile-open', mqMobile.matches);
  syncMobile();
  if (!toggle?.dataset.tocBound) {
    if (toggle) toggle.dataset.tocBound = '1';
    mqMobile.addEventListener('change', syncMobile);
    toggle?.addEventListener('click', () => {
      syncMobile();
      toc.classList.toggle('open');
    });
  }

  const links = Array.from(toc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'));
  links.forEach((a) => {
    if (a.dataset.tocBound) return;
    a.dataset.tocBound = '1';
    a.addEventListener('click', (e) => {
      const id = decodeURIComponent(a.getAttribute('href')!.slice(1));
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('toc-hl');
      void target.offsetWidth;
      target.classList.add('toc-hl');
      window.setTimeout(() => target.classList.remove('toc-hl'), 1000);
      toc.classList.remove('open');
    });
  });

  tocObserver?.disconnect();
  tocObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const targetId = (e.target as HTMLElement).id;
        /* 两边都 decode 成原始 id 再比：服务端链接是 `#章节01`（未编码），
           新建链接是 `#%E7%AB%A0...`（已编码），直接比字符串永远比不上，
           中文标题的滚动高亮就一直不亮。 */
        links.forEach((a) =>
          a.classList.toggle(
            'active',
            decodeURIComponent(a.getAttribute('href')!.slice(1)) === targetId
          )
        );
      });
    },
    { rootMargin: '-20% 0px -70% 0px' }
  );
  links.forEach((a) => {
    const el = document.getElementById(decodeURIComponent(a.getAttribute('href')!.slice(1)));
    if (el) tocObserver!.observe(el);
  });
}

/* ---- 图片灯箱：第一次适应屏幕，第二次原图大小，可拖动 / 滚轮缩放 ---- */
function initLightbox() {
  const box = document.querySelector<HTMLElement>('#lightbox');
  const img = box?.querySelector('img');
  if (!box || !img) return;
  let scale = 1,
    dragging = false,
    sx = 0,
    sy = 0,
    tx = 0,
    ty = 0,
    rawMode = false;

  /* ⚠️ 排除 .gallery-img / .gallery-side img：
       相册的大图由 initGalleries() 单独接管（要开的是「当前那一张」，
       直接绑死 el.src 会绑到初始的第一张）；
       两侧的**小图本身就是翻页按钮**，点它只该翻页，不该弹灯箱 ——
       不排除的话点小图会同时翻页 + 弹窗，看起来就成了「点小图是查看」。 */
  const open = (src: string, alt: string) => {
    img.src = src;
    img.alt = alt;
    rawMode = false;
    scale = 1;
    tx = ty = 0;
    img.classList.remove('raw');
    img.style.transform = '';
    box.classList.add('open');
  };
  /* 暴露出去：相册翻页后要能打开新的当前图，不能复用初始化时绑死的 src */
  (window as unknown as { __openLb?: typeof open }).__openLb = open;

  document
    .querySelectorAll<HTMLImageElement>('.prose img:not(.gallery-img):not(.gallery-side img)')
    .forEach((el) => el.addEventListener('click', () => open(el.src, el.alt)));

  const close = () => box.classList.remove('open');
  box.addEventListener('click', (e) => {
    if (e.target === box) close();
  });
  img.addEventListener('click', () => {
    // 第一次适应屏幕，第二次原图大小
    rawMode = !rawMode;
    img.classList.toggle('raw', rawMode);
    scale = 1;
    img.style.transform = '';
  });
  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.min(4, Math.max(0.2, scale * (e.deltaY > 0 ? 0.9 : 1.1)));
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }, { passive: false });
  img.addEventListener('mousedown', (e) => {
    dragging = true;
    sx = e.clientX - tx;
    sy = e.clientY - ty;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    tx = e.clientX - sx;
    ty = e.clientY - sy;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  });
  window.addEventListener('mouseup', () => (dragging = false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}

/* ---- 相册 :::gallery ----
   结构由 remark 插件（src/plugins/remark-gallery.mjs）生成，这里只接管交互：
     · 点左右小图 / 箭头 → 翻页（带方向动画）
     · 点中间大图 → 灯箱
     · 首尾只有一边小图（.is-void 隐藏但保留占位，大图始终居中） */
function initGalleries() {
  document.querySelectorAll<HTMLElement>('.gallery').forEach((g) => {
    const imgs = Array.from(g.querySelectorAll<HTMLImageElement>('.gallery-img'));
    const n = imgs.length;
    if (!n) return;
    const prev = g.querySelector<HTMLButtonElement>('.gallery-prev');
    const next = g.querySelector<HTMLButtonElement>('.gallery-next');
    const arrPrev = g.querySelector<HTMLButtonElement>('.gallery-arrow-prev');
    const arrNext = g.querySelector<HTMLButtonElement>('.gallery-arrow-next');
    const counter = g.querySelector<HTMLElement>('.gallery-count');
    const cap = g.querySelector<HTMLElement>('.gallery-caption');
    let i = 0;

    /* 侧边小图既是「预览」也是「按钮」—— 点它等于往那一边翻一页。
       idx 越界就置空并隐藏（首尾只显示一边）。 */
    const setSide = (btn: HTMLButtonElement | null, idx: number) => {
      if (!btn) return;
      const ok = idx >= 0 && idx < n;
      btn.classList.toggle('is-void', !ok);
      btn.tabIndex = ok ? 0 : -1;
      if (!ok) return;
      const s = btn.querySelector('img');
      if (s) {
        s.src = imgs[idx].src;
        /* alt 留空：按钮自带 aria-label，图片只是装饰性预览 */
        s.alt = '';
      }
    };

    /* dir: -1 上一张 / 1 下一张 / 0 初始渲染（不播入场动画） */
    const render = (dir: number) => {
      g.style.setProperty('--gdir', String(dir || 1));
      imgs.forEach((im, k) => {
        const cur = k === i;
        im.classList.remove('is-cur');
        if (cur) {
          if (dir !== 0) im.classList.add('is-anim');
          /* 先摘后加并强制重排：同一帧内 remove+add 浏览器会合并，
             CSS 动画不会重启（翻第二次就没动效了）。 */
          void im.offsetWidth;
          im.classList.add('is-cur');
        }
      });
      g.dataset.i = String(i);
      if (counter) counter.textContent = `${i + 1} / ${n}`;
      /* ⚠️ 不能直接写 cap.textContent：相册开了下载按钮时，按钮也在 caption 里，
         整段覆盖会把它冲掉（表现就是「明明设了 dl，页面上却没有按钮」）。
         只改说明文字那一层；老结构没有这个 span 时才退回整段写。 */
      const capT = cap?.querySelector<HTMLElement>('.gallery-cap-t');
      if (capT) capT.textContent = imgs[i].alt || '';
      else if (cap) cap.textContent = imgs[i].alt || '';
      setSide(prev, i - 1);
      setSide(next, i + 1);
      arrPrev?.classList.toggle('is-void', i === 0);
      arrNext?.classList.toggle('is-void', i === n - 1);
    };

    const go = (d: number) => {
      const t = i + d;
      if (t < 0 || t >= n) return;
      i = t;
      render(d);
    };

    prev?.addEventListener('click', () => go(-1));
    next?.addEventListener('click', () => go(1));
    arrPrev?.addEventListener('click', () => go(-1));
    arrNext?.addEventListener('click', () => go(1));

    /* 只有当前那张开灯箱 —— 其余图虽然也在 DOM 里（绝对定位叠着），
       但 pointer-events: none，点不到；这里再判一次更保险。 */
    imgs.forEach((im, k) =>
      im.addEventListener('click', () => {
        if (k !== i) return;
        (window as unknown as { __openLb?: (s: string, a: string) => void }).__openLb?.(im.src, im.alt);
      })
    );

    render(0);
  });
}

/* ---- 单张便签插图的说明文字（运行时兜底） ----
   remark-note-image 会在构建期把 alt 摆到图下面，但改插件不会重编已编译的
   markdown、旧 dist / 缓存 HTML / View Transitions 复用的老 DOM 都还是
   <p><img alt="…"></p> —— alt 在图片正常加载时浏览器根本不显示。
   这里按同一套结构补一行，插件已经给过就不重复。 */
function initNoteCaptions() {
  document.querySelectorAll('.prose p > img:not(.gallery-img)').forEach((img) => {
    const p = img.parentElement;
    if (!p) return;
    if (p.getAttribute('data-note-cap') === '1' || p.querySelector('.note-cap')) return;
    /* 只认「整段只有这一张图」，或「图在段首、后面还跟着文字」。
       markdown 里图片行紧贴下一行文字属于同一个 paragraph，构建期插件不会补，
       但用户就是这么写的 —— 运行时把图拆成独立一段再补说明。
       文字夹在图片中间的行内图一律不动。 */
    const nodes = Array.from(p.childNodes);
    const idx = nodes.indexOf(img);
    const before = nodes.slice(0, idx);
    const after = nodes.slice(idx + 1);
    /* 不用带类型注解的辅助函数：这段会被测试脚本整段提取出来直接跑，
       留着 `: ChildNode[]` 会让提取出的片段在浏览器里语法错误。 */
    const beforeOK = before.every((n) => n.nodeType === 3 && !(n.textContent || '').trim());
    /* 图后面只允许纯文字，不能还有别的元素（那种是复杂混排，别动） */
    const afterAllText = after.every((n) => n.nodeType === 3);
    if (!beforeOK || !afterAllText) return;
    const standalone = after.every((n) => !(n.textContent || '').trim());
    const alt = (img.getAttribute('alt') || '').trim();
    if (!alt) return;
    const cap = document.createElement('span');
    cap.className = 'note-cap';
    cap.textContent = alt;
    if (standalone) {
      img.insertAdjacentElement('afterend', cap);
      p.classList.add('has-note-cap');
      p.setAttribute('data-note-cap', '1');
    } else if (p.parentNode) {
      const box = document.createElement('p');
      box.className = 'has-note-cap';
      box.setAttribute('data-note-cap', '1');
      p.parentNode.insertBefore(box, p);
      box.appendChild(img);
      box.appendChild(cap);
      nodes.forEach((n) => { if (n !== img && n.parentNode === p) p.removeChild(n); });
      after.forEach((n) => p.appendChild(n));
    }
  });
}

/* ---- 代码块：包一层容器，加语言标签 + 复制按钮，悬停显示 ---- */
function initCodeBlocks() {
  const pres = Array.from(document.querySelectorAll<HTMLElement>('.prose pre'));
  pres.forEach((pre) => {
    if (pre.parentElement?.classList.contains('code-block')) return;
    const block = document.createElement('div');
    block.className = 'code-block';
    block.dataset.lang = pre.dataset.language || 'text';
    pre.parentElement?.insertBefore(block, pre);
    block.appendChild(pre);
  });

  document.querySelectorAll<HTMLElement>('.code-block').forEach((block) => {
    const pre = block.querySelector('pre');
    if (!pre || block.querySelector('.code-tools')) return;

    // shiki 会在每行之间留下字面换行文本节点；pre 的 white-space: pre 会把它们
    // 渲染成真实的空行 → 行距翻倍；同时 innerText 也会因此多出空行。清掉它们。
    const codeEl = pre.querySelector('code');
    if (codeEl) {
      Array.from(codeEl.childNodes).forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE && !(n.nodeValue ?? '').trim()) n.remove();
      });
    }

    const lang = block.dataset.lang || 'text';
    const wrap = document.createElement('div');
    wrap.className = 'code-tools';
    const tag = document.createElement('span');
    tag.className = 'code-lang';
    tag.textContent = lang;
    const copy = document.createElement('button');
    copy.className = 'code-copy';
    copy.type = 'button';
    copy.textContent = '复制';
    copy.addEventListener('click', async () => {
      // 逐行取 textContent 再拼接：不带 block 换行、不带 shiki 的字面换行，
      // 复制出来的就是原始代码，不会多出空行。
      const lineEls = Array.from(pre.querySelectorAll('code .line'));
      const code = lineEls.length
        ? lineEls.map((l) => l.textContent ?? '').join('\n')
        : (pre.querySelector('code')?.textContent ?? '');
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        /* 忽略：非安全上下文下退化为不复制 */
      }
      copy.textContent = '已复制';
      window.setTimeout(() => (copy.textContent = '复制'), 1400);
    });
    wrap.append(tag, copy);
    block.appendChild(wrap);
  });
}

/* ---- 移动端汉堡菜单 ---- */
function initHamburger() {
  const btn = document.querySelector<HTMLButtonElement>('#hamburger');
  const panel = document.querySelector<HTMLElement>('#mobile-panel');
  const closeBtn = document.querySelector<HTMLButtonElement>('#mobile-close');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => panel.classList.toggle('open'));
  closeBtn?.addEventListener('click', () => panel.classList.remove('open'));
  panel.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => panel.classList.remove('open')));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && panel.classList.remove('open'));
}

/* ---- 首页的 B：点击拆散重组，1 秒回组织 ----
   SVG 已内联，能拿到内部部件，所以是逐件向外扩散再拼回，
   而不是整体形变。部件数量按原稿自适应。

   锁的实现要点（之前「连点会反复触发」的根因）：
   ① 锁必须是**模块级**的，不能是 each 元素各自闭包里的局部变量 ——
      一旦 initB 被重复执行（或元素被替换后重新绑定），每个闭包都有自己
      的 busy，第 2 份监听器看到的是 false，锁就形同虚设。
   ② 用**时间戳**而不是布尔量：解锁时刻 = 点击时刻 + 1000ms。
      animationend 只用来「提前」收尾 class，不再负责解锁 ——
      否则任何一个后代元素的其它动画结束（或某个部件时长被算成 0）都会
      提前把锁打开。
   ③ 用**事件委托**绑在 document 上，不绑在具体元素上 ——
      元素被重新渲染换掉之后监听不会丢，也不会重复叠加。 */
const B_LOCK_MS = 1000;
let bLockUntil = 0;

function initB() {
  /* 委托到 document：B 元素被重新渲染替换后依然生效，且不会重复绑定 */
  document.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    const el = t?.closest?.('[data-b-action]') as HTMLElement | null;
    if (!el) return;

    const now = performance.now();
    if (now < bLockUntil) return;        // 动画进行中：直接忽略，不重启动画
    bLockUntil = now + B_LOCK_MS;

    /* 强制重启动画：万一上一次的 class 还没清掉，先移除 + 触发重排再加回 */
    el.classList.remove('b-shatter');
    void el.offsetWidth;
    el.classList.add('b-shatter');
    triggerB(el);

    /* 双保险：动画期间连 pointer-events 都关掉。
       时间戳锁已经够用，但漂浮动画会让 B 缓慢移动，快速连点时
       某一次可能落在「上一个位置」的元素碎片上；关掉命中测试就彻底点不到。 */
    el.classList.add('b-locked');

    /* 动画结束后清掉 class（下一帧才能再播）。
       不负责解锁 —— 解锁只由上面的时间戳决定。 */
    window.setTimeout(() => {
      document.querySelectorAll('.b-locked').forEach((e) => e.classList.remove('b-locked'));
      if (performance.now() >= bLockUntil) el.classList.remove('b-shatter');
      else window.setTimeout(() => el.classList.remove('b-shatter'), 80);
    }, B_LOCK_MS + 40);
  });
}

/**
 * 世界切换后，B 的 SVG 会被 React / Astro 重新渲染成**新的 DOM 节点** ——
 * 而 inkSvgB / prepareBShatter 只在 initUI 时跑过一次，打在旧节点上的
 * .b-ink / .b-part 全没了。结果是：切完世界后 B 既不变色、也散不开。
 * 所以 worldchange 之后必须重新跑一遍。
 */
function refreshSvgB() {
  inkSvgB();
  prepareBShatter();
}
window.addEventListener('worldchange', () => {
  // 世界切换的动效是 1 秒、中段（500ms）才换色，等 DOM 稳定后再补
  window.setTimeout(refreshSvgB, 620);
});

/**
 * 给 B 的每个部件预先算好「往哪散」：方向 = 部件中心相对 SVG 中心的方向，
 * 距离 = viewBox 宽度的 45%，再错开一点起始时间和旋转角度。
 *
 * 两个坑：
 * 1. 只取顶层元素可能只有 1 个（整图常被包在一个 <g> 里），那就往下钻一层，
 *    否则「散开」会变成整块平移，没效果。
 * 2. 部件可能自带 transform 属性，而 CSS transform 会整个盖掉它 ——
 *    所以先把静止时的 computed transform 存进 --base，动画里拼在最前面，
 *    不然动画一开始部件就会跳位。
 */
function prepareBShatter() {
  const isGfx = (el: Element): el is SVGGraphicsElement =>
    typeof SVGGraphicsElement !== 'undefined' && el instanceof SVGGraphicsElement;

  document.querySelectorAll<SVGSVGElement>('.svg-b svg').forEach((svg) => {
    if (svg.dataset.scatter) return; // 只做一次
    svg.dataset.scatter = '1';

    let parts: SVGGraphicsElement[] = [...svg.children].filter(isGfx);
    let depth = 0;
    while (parts.length < 2 && depth < 3) {
      const next = parts.flatMap((c) => [...c.children].filter(isGfx));
      if (!next.length) break;
      parts = next;
      depth++;
    }
    if (!parts.length) return;

    const vb = svg.viewBox.baseVal;
    const cx = vb.width ? vb.x + vb.width / 2 : 0;
    const cy = vb.height ? vb.y + vb.height / 2 : 0;
    const reach = (vb.width || 100) * 0.45;

    parts.forEach((el, i) => {
      let bb: DOMRect;
      try {
        bb = el.getBBox();
      } catch {
        return;
      }
      const dx = bb.x + bb.width / 2 - cx;
      const dy = bb.y + bb.height / 2 - cy;
      const len = Math.hypot(dx, dy);
      /* 正好落在中心的部件：dx/dy 都是 0，单位向量算不出来（会把 NaN 或 0 写进
         --ox/--oy，那它就会原地不动，看起来像没参与散开）。
         改成按序号均匀分配一个方向，谁都不会掉队。 */
      let ux: number, uy: number;
      if (len > 0.01) {
        ux = dx / len;
        uy = dy / len;
      } else {
        const ang = (i / parts.length) * Math.PI * 2 + 0.6;
        ux = Math.cos(ang);
        uy = Math.sin(ang);
      }
      const rot = (i % 2 ? 1 : -1) * (8 + ((i * 13) % 14));
      const base = getComputedStyle(el).transform;

      el.classList.add('b-part');
      el.style.setProperty('--ox', (ux * reach).toFixed(2));
      el.style.setProperty('--oy', (uy * reach).toFixed(2));
      el.style.setProperty('--rot', `${rot.toFixed(1)}deg`);
      // 错开起始时间；CSS 里动画时长会减掉这个延迟，保证所有部件都在 1000ms 收尾
      el.style.setProperty('--d', `${Math.min(i * 22, 110)}ms`);
      /* 没有 transform 时不能写空字符串 —— var(--base) 展开成空会让整条
         transform 声明失效（实测 computed 变成 none，部件完全不动）。
         写一个恒等的 translate(0px, 0px) 兜底。 */
      el.style.setProperty('--base', base && base !== 'none' ? base : 'translate(0px, 0px)');
    });
  });
}

/* ---- 卡片简介 tooltip：截断时悬停显示完整文字 ----
   用 JS 创建的全局浮层，而不是 CSS ::after ——
   简介有 overflow: hidden（ellipsis 必需），伪元素会被裁掉，根本显示不出来。 */
function initTooltips() {
  let tip: HTMLElement | null = null;
  let cur: HTMLElement | null = null;
  let showTimer = 0;

  const ensure = () => {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    return tip;
  };

  /** 是否真的被截断：横向（单行省略）或纵向（line-clamp）超出都算 */
  const truncated = (el: HTMLElement) =>
    el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;

  const hide = () => {
    window.clearTimeout(showTimer);
    if (tip) tip.classList.remove('on');
    cur?.removeAttribute('data-tip-on');
    cur = null;
  };

  const place = (el: HTMLElement, t: HTMLElement) => {
    t.textContent = el.dataset.tip ?? '';
    /* 先显示再量 —— display:none 时量不到尺寸 */
    t.classList.add('on');
    const r = el.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const M = 10; // 距屏幕边缘的最小留白
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(M, Math.min(left, window.innerWidth - tr.width - M));
    /* 默认放上方，上方放不下就翻到下方 */
    let top = r.top - tr.height - 8;
    if (top < M) top = r.bottom + 8;
    t.style.left = `${Math.round(left)}px`;
    t.style.top = `${Math.round(top)}px`;
  };

  const show = (el: HTMLElement) => {
    if (!el.dataset.tip || !truncated(el)) return;
    cur = el;
    el.setAttribute('data-tip-on', '');
    const t = ensure();
    window.clearTimeout(showTimer);
    showTimer = window.setTimeout(() => place(el, t), 60); // 轻微延迟，避免划过时乱闪
  };

  /* 委托到 document：卡片是 React 动态插入的，逐个绑定会漏 */
  document.addEventListener('mouseover', (e) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]');
    if (!el || el === cur) return;
    if (cur) hide();
    show(el);
  });
  document.addEventListener('mouseout', (e) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]');
    if (!el) return;
    /* 移到 tooltip 自身不算离开 */
    const to = (e as MouseEvent).relatedTarget as Element | null;
    if (to && (to.id === 'tip' || to.closest?.('[data-tip]'))) return;
    hide();
  });
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('resize', hide);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
}

/* ---- 页脚随机文字：从文件读随机行，每次刷新随机 ---- */
function initRandomFooter() {
  const el = document.querySelector<HTMLElement>('#footer-random');
  const src = el?.dataset.source;
  if (!el || !src) return;
  fetch(src)
    .then((r) => r.text())
    .then((text) => {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length) el.textContent = lines[Math.floor(Math.random() * lines.length)];
    })
    .catch(() => {
      /* 读不到就留空 */
    });
}

/* ---- 友情链接：折叠，展开后漂浮在随机位置，随机颜色，且互不遮挡 ----
   散布方式：先把容器切成足够大的格子（格宽 ≥ 最宽链接 + 间距），
   再把链接随机分配到格子、在格内随机偏移 —— 位置随机，但每个都待在自己的格子里，
   所以永远不会重叠，也不会被挤到看不见。 */
/* ------------------------------------------------------------------
   友情链接：展开后是一片「宇宙」
     · 区域高度按内容量出来（链接多少、图片大小都影响）
     · 链接：文字 14~24px 随机 / 图片按宽高比分档（横条 130~190px、方形 60~96px），保持比例
     · 随机位置 + 漂浮，且互不遮挡（随机撒点 + 碰撞重试，撒不下就长高）
     · 装饰：夜间星星月亮，日间云朵太阳；数量随区域大小自适应
     · 四周径向渐隐；悬停放大 + 发光；点击跳官网
   ------------------------------------------------------------------ */

/* 装饰图形：内联 SVG。夜间一套、日间一套。 */
const DECO = {
  star: () => `<svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.6l2.7 6.1 6.6.6-5 4.3 1.5 6.5L12 15.7 6.2 19.1l1.5-6.5-5-4.3 6.6-.6z"/></svg>`,
  moon: () => `<svg width="100%" height="100%" viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M20.5 3a13 13 0 1 0 8.4 20.3A14.5 14.5 0 0 1 20.5 3z"/></svg>`,
  cloud: () => `<svg width="100%" height="100%" viewBox="0 0 40 24" aria-hidden="true"><path fill="currentColor" d="M10.5 22a7.5 7.5 0 0 1-.6-15 9.5 9.5 0 0 1 17.8 2.4A6.5 6.5 0 0 1 28.5 22z"/></svg>`,
  sun: () => `<svg width="100%" height="100%" viewBox="0 0 40 40" aria-hidden="true"><g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="20" cy="20" r="8.5" fill="currentColor" stroke="none"/><path d="M20 2.5v4M20 33.5v4M2.5 20h4M33.5 20h4M7.6 7.6l2.8 2.8M29.6 29.6l2.8 2.8M32.4 7.6l-2.8 2.8M10.4 29.6l-2.8 2.8"/></g></svg>`,
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * 友情链接图片：悬停沿 Y 轴持续翻转，移开后继续转满一整圈、回到 0 度才停。
 * 效果来自用户给的 .image-container 那段脚本；移植时修了它两个真问题：
 *   ① 原脚本每次 mouseenter / mouseleave 都直接调 animateRotation() 新起一条 rAF 链，
 *      循环里只判断「还在不在转」，于是多条链会同时给角度 +2 → 越转越快、停不下。
 *      这里用 running 保证每张图片同时只有一条链。
 *   ② 正在「转回 0」时鼠标再移入，原脚本直接忽略 → 看着像没反应。
 *      这里 mouseenter 直接取消恢复、接着转。
 *
 * transform 必须挂在最内层 <img> 上：
 *   .friend-item 被 friend-drift 每帧占着 transform（漂浮），
 *   .friend-in 是 hover 放大 scale(1.18) / friend-appear 的载体，
 *   只有 img 的 transform 是空的，三者才不打架 —— CSS 一个字都不用改。
 *
 * 用 data-flip 跟着 DOM 做幂等：initUI() 可能被重复调用（页面切换 / View
 * Transitions），randomize() 每次展开也会重扫，重复绑定只会让动画翻倍。
 */
function bindFriendFlip(els: HTMLElement[]) {
  /* 系统开了「减少动态效果」就不翻，图片保持原样、链接照常能点 */
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  els.forEach((el) => {
    if (!el.classList.contains('is-img')) return;   // 文字链接不参与
    const img = el.querySelector<HTMLImageElement>('img');
    if (!img || img.dataset.flip === '1') return;
    img.dataset.flip = '1';

    const SPEED = 2;
    let angle = 0;         // 0~360，停下时必定是 0
    let spinning = false;  // 鼠标在内：一直转
    let restoring = false; // 鼠标已离开：转到下一圈归零再停
    let running = false;   // 是否已有 rAF 链在跑

    const tick = () => {
      if (!spinning && !restoring) { running = false; return; }
      angle += SPEED;
      if (angle >= 360) {
        /* 从 0 起每次 +2，360 能被整除，必然精确落在 360；
           直接置 0 而不是取模，避免停在 1 度那种歪着的状态。 */
        angle = 0;
        if (restoring) restoring = false;
      }
      img.style.transform = `rotateY(${angle}deg)`;
      requestAnimationFrame(tick);
    };
    const kick = () => {
      if (running) return;   // 关键：绝不启动第二条链
      running = true;
      requestAnimationFrame(tick);
    };

    el.addEventListener('mouseenter', () => {
      restoring = false;     // 取消「正在归零」，鼠标回来接着转
      spinning = true;
      kick();
    });
    el.addEventListener('mouseleave', () => {
      if (!spinning) return;
      spinning = false;
      restoring = angle !== 0;   // 已经正好 0 度就直接停
      if (restoring) kick();
    });
  });
}

function initFriendLinks() {
  const btn = document.querySelector<HTMLButtonElement>('#friends-toggle');
  const field = document.querySelector<HTMLElement>('#friend-field');
  if (!btn || !field) return;

  /* 每次排版都重新收集 —— 链接条目可能后来才加进来（内容替换后不用改 JS） */
  const getItems = () => Array.from(field.querySelectorAll<HTMLElement>('.friend-item'));
  if (!getItems().length) return;

  const palette = ['#5b8fc7', '#7cff4f', '#c77bff', '#f5a623', '#4ad8d8', '#ff6b8a', '#9dc2e8'];
  const GAP = 16;      // 链接之间的最小空隙
  const EDGE = 30;     // 距区域边缘的最小距离（渐隐区，别把链接放进去）
  const DECO_EDGE = 8; // 装饰可以贴边一点（它本来就在最底层，边缘会被 mask 淡掉）
  const DRIFT = 8;     // 漂浮幅度上限

  /* 每展开一次重新随机字号 / 图片尺寸 —— 位置也跟着重排。
     翻转绑定也在这里重扫一遍：以后若往数组里加了图片链接，不用另改初始化代码；
     bindFriendFlip 自带幂等，重复调用不会让动画翻倍。 */
  const randomize = () => {
    bindFriendFlip(getItems());
    getItems().forEach((el) => {
      const img = el.querySelector('img');
      if (img) {
        /* 站名横排的宽幅 logo（内联 SVG 字标最常见）长边是「宽度」：
           统一按 40~80px 限大边，600×100 的图会被压成 60×10px，
           字比旁边 14~24px 的文字链接还小（实测 8.6~15px），看着就是一个点。
           所以按宽高比分档：宽幅给 130~190px（视觉高约 23~33px），
           方形给 60~96px。CSS 里 max-width/max-height 都取 --sz，
           两边同时封顶 → 不拉伸、不裁剪，各自比例保持。
           naturalWidth 可用是因为 layout() 在 await waitAssets() 之后才调本函数。 */
        const nw = img.naturalWidth || 1;
        const nh = img.naturalHeight || 1;
        const [lo, hi] = nw / nh >= 2 ? [130, 190] : [60, 96];
        el.style.setProperty('--sz', `${rand(lo, hi).toFixed(0)}px`);
      } else {
        el.style.setProperty('--fsz', `${rand(14, 24).toFixed(1)}px`);
      }
      const color = palette[Math.floor(Math.random() * palette.length)];
      el.style.setProperty('--fi-color', color);
    });
  };

  /** 撒点：随机位置 + 碰撞重试。装不下就返回 false，由调用方加高重试 */
  /**
   * 网格分配：把可用区域切成 cols × rows 个格子，每个链接随机占一个，格内再随机抖动。
   *
   * 为什么不用「随机撒点 + 碰撞重试」：那个在链接多的时候会退化 ——
   * 后来的链接找不到空位就只能把区域越撑越高，而且容易出现「一边挤一堆、一边空一片」。
   * 网格天然保证：① 一个格子最多一个 → 不可能重叠；② 每个格子都被用到 → 分布均匀。
   *
   * 格子顺序打乱，所以视觉上仍是随机的，不是按顺序排的表格。
   */
  const gridPlace = (
    els: HTMLElement[], W: number, H: number,
    opt: { edge?: number; gap?: number; padY?: number } = {},
  ) => {
    const edge = opt.edge ?? EDGE;
    const gap = opt.gap ?? GAP;
    if (!els.length) return { cols: 0, rows: 0, ok: true };

    const boxes = els.map((el) => ({ el, w: el.offsetWidth, h: el.offsetHeight }));
    const maxW = Math.max(...boxes.map((b) => b.w));
    const maxH = Math.max(...boxes.map((b) => b.h));

    const innerW = W - edge * 2;
    if (innerW <= 0) return { cols: 0, rows: 0, ok: false };

    /* 列数：一排能塞下几个「链接宽 + 两侧间隙」就放几个，最多等于链接数
       （链接少时不要把格子拉得奇宽） */
    const cellW = maxW + gap * 2;
    let cols = Math.max(1, Math.min(els.length, Math.floor(innerW / cellW)));
    /* 列数太多会让每行都很矮，看着像列表不像星云 —— 收一收 */
    cols = Math.max(1, Math.min(cols, Math.ceil(Math.sqrt(els.length * 1.6))));
    const rows = Math.ceil(els.length / cols);

    const availH = H - edge * 2;
    /* ⚠️ cellW / cellH 只是「能放下所需的最小格子」，用来算 cols；
       真正布局要用「均分后的格子」colW / rowH —— 否则链接少的时候
       列数被收窄，格子只占左边一小条，右边一大片空（实测 6 个链接只铺到 426/1080）。 */
    const colW = innerW / cols;
    const rowH = availH / rows;
    /* 格子装不下（高度不够）就报失败，由调用方加高重试 */
    if (rowH < maxH + gap) return { cols, rows, ok: false };

    /* 打乱格子顺序：让分配是随机的，而不是从左上角依次填 */
    const slots: { r: number; c: number }[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) slots.push({ r, c });
    for (let i = slots.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      [slots[i], slots[k]] = [slots[k], slots[i]];
    }

    boxes.forEach((b, i) => {
      const s = slots[i % slots.length];
      /* 格内随机抖动：可用余量是「格子 - 链接 - 间隙」，四周各留 gap/2，
         这样相邻格子的内容之间至少有 gap，漂移也不会撞上 */
      const jx = Math.max(0, colW - b.w - gap);
      const jy = Math.max(0, rowH - b.h - gap);
      const x = edge + s.c * colW + gap / 2 + Math.random() * jx;
      const y = edge + s.r * rowH + gap / 2 + Math.random() * jy;
      b.el.style.left = `${x.toFixed(1)}px`;
      b.el.style.top = `${y.toFixed(1)}px`;
    });

    return { cols, rows, ok: true };
  };

  const scatter = (W: number, H: number) => {
    const items = getItems();
    const g = gridPlace(items, W, H);
    if (!g.ok) return false;

    /* 漂浮参数：幅度、周期、起始相位各不相同，才像各自在漂 */
    items.forEach((el) => {
      el.style.setProperty('--dx', `${rand(-DRIFT, DRIFT).toFixed(1)}px`);
      el.style.setProperty('--dy', `${rand(-DRIFT, DRIFT).toFixed(1)}px`);
      el.style.animationDuration = `${rand(6, 12).toFixed(1)}s`;
      el.style.animationDelay = `${(-rand(0, 10)).toFixed(1)}s`;
    });
    /* 网格参数写进 dataset，测试可以按同一套网格逐格校验（也方便调试） */
    field.dataset.cols = String(g.cols);
    field.dataset.rows = String(g.rows);
    field.dataset.edge = String(EDGE);
    return true;
  };


  /** 装饰：数量按区域面积自适应，夜间星星月亮 / 日间云朵太阳 */
  /** 建一个装饰元素（只定尺寸和图形，位置交给网格分配） */
  const makeDeco = (kind: keyof typeof DECO, size: number) => {
    const d = document.createElement('span');
    d.className = 'friend-deco';
    d.dataset.kind = kind;
    d.setAttribute('aria-hidden', 'true');
    d.style.width = `${size.toFixed(1)}px`;
    d.style.height = `${size.toFixed(1)}px`;
    d.innerHTML = DECO[kind]();
    field.appendChild(d);
    return d;
  };

  /** 给一批元素随机化漂浮参数（幅度 / 周期 / 相位 / 目标不透明度） */
  const driftify = (
    els: HTMLElement[],
    opt: { amp?: number; dur?: [number, number]; op?: [number, number] } = {},
  ) => {
    const amp = opt.amp ?? 10;
    const [d0, d1] = opt.dur ?? [9, 18];
    const [o0, o1] = opt.op ?? [0.35, 0.85];
    els.forEach((e) => {
      e.style.setProperty('--dx', `${rand(-amp, amp).toFixed(1)}px`);
      e.style.setProperty('--dy', `${rand(-amp, amp).toFixed(1)}px`);
      e.style.animationDuration = `${rand(d0, d1).toFixed(1)}s`;
      e.style.animationDelay = `${(-rand(0, 12)).toFixed(1)}s`;
      e.style.setProperty('--op', rand(o0, o1).toFixed(2));
    });
  };

  /**
   * 装饰：小元素（星星 / 云朵）用网格分配 —— 和链接同一套逻辑，
   * 所以也是「分布均匀、不会挤成一堆」。
   * 大元素（月亮 / 太阳）仍然只放一个、固定在右上角内侧：
   * 它体积大，随机撒会压住链接；而且「天上那个」位置稳定才像天体。
   */
  const buildDeco = (W: number, H: number) => {
    field.querySelectorAll('.friend-deco').forEach((e) => e.remove());
    const dark = document.documentElement.dataset.theme === 'dark';
    const n = Math.max(8, Math.min(24, Math.round((W * H) / 17000)));

    const small = dark ? 'star' : 'cloud';
    const [s0, s1] = dark ? [5, 15] : [16, 34];
    const smalls: HTMLElement[] = [];
    for (let i = 0; i < n; i++) smalls.push(makeDeco(small, rand(s0, s1)));

    /* 装饰可以贴近边缘（mask 会把边缘淡掉），所以 edge 取小值 */
    const g = gridPlace(smalls, W, H, { edge: DECO_EDGE, gap: 12 });
    field.dataset.dcols = String(g.cols);
    field.dataset.drows = String(g.rows);
    field.dataset.dedge = String(DECO_EDGE);
    driftify(smalls, { amp: dark ? 8 : 7, dur: [9, 18], op: dark ? [0.3, 0.9] : [0.35, 0.8] });

    const big = dark ? 'moon' : 'sun';
    const bs = dark ? rand(30, 46) : rand(34, 52);
    const bd = makeDeco(big, bs);
    bd.style.left = `${(W - bs - rand(24, 70)).toFixed(1)}px`;
    bd.style.top = `${rand(18, Math.max(20, H * 0.28)).toFixed(1)}px`;
    driftify([bd], { amp: 7, dur: [13, 20], op: [dark ? 0.92 : 0.9, dark ? 0.92 : 0.9] });

    /* 新建元素的 opacity 一开始就命中 .open 的目标值，transition 不会触发。
       所以先强制 opacity:0 生效（读一次 offsetWidth），下一帧再撤掉内联值，
       让它从 0 过渡到 --op。 */
    const all = Array.from(field.querySelectorAll<HTMLElement>('.friend-deco'));
    all.forEach((e) => { e.style.opacity = '0'; });
    void field.offsetWidth;
    window.requestAnimationFrame(() => {
      all.forEach((e) => { e.style.opacity = ''; });
    });
  };

  /** 星云椭圆：大小跟内容走 —— 高度直接用区域高，宽度也随之放大 */
  const sizeGlow = (W: number, H: number) => {
    const glow = field.querySelector<HTMLElement>('#friend-glow');
    if (!glow) return;
    const w = Math.min(W * 0.99, H * 1.6 + W * 0.42);
    const h = H * 0.98;
    glow.style.width = `${Math.round(w)}px`;
    glow.style.height = `${Math.round(h)}px`;
  };

  /** 图片没加载完时量到的宽度是 0 —— 会把链接放到区域外面去（实测越界 34px）。
      所以排版前必须等图片；出错或超时也要放行，不能卡住整个展开。 */
  const waitAssets = async () => {
    const imgs = Array.from(field.querySelectorAll('img'));
    await Promise.all(imgs.map((img) => {
      if (img.complete && img.naturalWidth) return Promise.resolve();
      return new Promise<void>((res) => {
        const done = () => res();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        window.setTimeout(done, 2500);
      });
    }));
    // 字体晚一步到位会改变文字宽度，也可能让已经排好的位置撞上
    try { await document.fonts?.ready; } catch { /* 不支持就跳过 */ }
  };

  /** 撒完再自查一遍：万一有尺寸在排版后才定型（字体/图片晚到），重新撒一次 */
  const overlaps = () => {
    const bs = getItems().map((el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
    let n = 0;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], c = bs[j];
        if (a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y) n++;
      }
    }
    return n;
  };

  const layout = async () => {
    const W = field.clientWidth;
    if (!W) return;

    /* ⚠️ 先给一个初始高度，让展开动画**立刻**开始播，再去等图片/字体。
       原来的写法是先 `await waitAssets()`（含 document.fonts.ready）再设高度 ——
       Google Fonts 慢或不可达时，点击「展开」后高度长时间保持 0，
       动画根本不播（实测逐帧采样 1.5 秒里只采到 h=0），看起来像点了没反应。
       现在：先落高度 → 动画起步 → 资源就绪后重排，高度再平滑过渡到最终值。 */
    if (!field.style.height) {
      field.style.height = '300px';
      sizeGlow(W, 300);
    }

    await waitAssets();
    randomize();
    // 先把装饰清掉再量尺寸：装饰是 absolute，不影响 clientWidth，但清掉更省事
    field.querySelectorAll('.friend-deco').forEach((e) => e.remove());
    getItems().forEach((el) => { el.style.left = '-9999px'; el.style.top = '0px'; });

    /* 高度：先给一个下限 300px（太矮不像星云），装不下就逐步加高。
       网格分配下每格只要能放下一个链接即可，不需要像撒点那样留大片空地。 */
    let H = 300;
    for (let i = 0; i < 10; i++) {
      if (scatter(W, H)) break;
      H += 90;
    }
    /* 兜底：撒完仍有重叠（尺寸在排版后才定型的极端情况）就加高重排，最多 3 次 */
    for (let i = 0; i < 3 && overlaps() > 0; i++) {
      H += 90;
      scatter(W, H);
    }
    field.style.height = `${H}px`;
    sizeGlow(W, H);

    /* 逐个浮现的错开延迟（--ad）。要在撒完点之后设，动画才从最终位置开始 */
    getItems().forEach((el, i) => {
      el.style.setProperty('--ad', `${Math.min(i * 45, 400)}ms`);
    });
    /* is-laid 触发 friend-appear；先移除再加，重复展开才会重新播 */
    field.classList.remove('is-laid');
    void field.offsetWidth;
    field.classList.add('is-laid');

    buildDeco(W, H);
  };

  const open = () => {
    /* open 触发高度 + 透明度过渡；is-laid 由 layout() 在撒完点之后加，
       触发逐个浮现 —— 两个分开，是因为排版要等图片/字体。
       现在 layout() 会先落一个初始高度，所以点击后动画是立刻起步的。 */
    field.classList.add('open');
    btn.textContent = '收起';
    btn.setAttribute('aria-expanded', 'true');
    // layout 现在是 async（要等图片/字体），用 rAF 包一层保证先展开再排版
    window.requestAnimationFrame(() => { void layout(); });
  };
  const close = () => {
    /* 清掉内联高度：下次展开时 layout() 才会重新落初始高度并播动画。
       不清的话 field.style.height 一直是最终值，展开动画就没有「从 0 长出来」的过程。 */
    field.classList.remove('open');
    field.classList.remove('is-laid');
    field.style.height = '';
    const glow = field.querySelector<HTMLElement>('#friend-glow');
    if (glow) { glow.style.width = '0px'; glow.style.height = '0px'; }
    btn.textContent = '展开';
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', () => (btn.getAttribute('aria-expanded') === 'true' ? close() : open()));

  let rt = 0;
  window.addEventListener('resize', () => {
    if (btn.getAttribute('aria-expanded') !== 'true') return;
    window.clearTimeout(rt);
    rt = window.setTimeout(layout, 180);
  });

  /* 明暗切换时装饰要换（星星月亮 ↔ 云朵太阳）。
     initTheme 只改 data-theme，没有事件，所以用 MutationObserver 盯住 html。 */
  new MutationObserver(() => {
    if (btn.getAttribute('aria-expanded') !== 'true') return;
    buildDeco(field.clientWidth, field.clientHeight);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
