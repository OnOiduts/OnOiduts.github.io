/**
 * 静态站资源防护层（减速带，不是安全边界）
 * ------------------------------------------------------------------
 * 适用前提：GitHub Pages —— 纯静态托管，没有服务端、没有边缘函数、发不了响应头。
 *
 * ⚠️ 必须先说清楚做不到什么：
 *   只要浏览器能把图片/视频/音频渲染出来，字节就一定完整送到了用户设备。
 *   F12 的 Network 面板能看到每一条请求，curl / Copy as cURL 不受页面脚本影响，
 *   磁盘缓存、录屏、音频回环也都能拿走。关掉 JavaScript 本模块全部失效。
 *   所以这里只把「随手右键/拖拽就能拿」变成「要费点劲」，不做反 DevTools、
 *   不做 debugger 循环、不全局禁右键、不禁用文字选中（误伤远大于收益）。
 *
 * 本模块拦的具体动作：
 *   ① 右键菜单 —— 图片「图片另存为 / 在新标签页打开图片」、视频「保存视频为 /
 *      复制视频地址 / 画中画」都在这个菜单里，菜单不弹出就都没有
 *   ② 拖拽保存 —— 把 img / video 拖到桌面、拖到地址栏、拖进另一个标签页
 *   ③ 中键 / Ctrl(⌘)+点击 打开 —— 媒体若被 <a> 包着时的另开窗口路径
 *   ④ iOS 长按弹出「存储图像」（CSS -webkit-touch-callout）
 *   ⑤ 原生控件里的下载按钮 / 画中画（controlsList）
 *   ⑥ 播放器建好后擦掉 data-src，Elements 面板里不再直接躺着资源路径
 *      （例外：作者写了 dl 的下载按钮，href 是有意保留的）
 *
 * ⚠️ 故意不做的两件事：
 *   - 不把 video/audio 的 src 换成 blob: URL。那是唯一能让「复制地址栏打不开」
 *     的做法，但要先把整个文件 fetch 进内存 → 丢掉 Range 流式播放，
 *     快进 / 逐帧会退化。之前已因服务器不支持 Range 踩过一次测试全 FAIL，不重蹈。
 *   - 不拦 figcaption / 正文 / 外链 <a> 的右键。那些是文字和平台页面
 *     （B站/网易云），既不是本站资源，拦了还会让嵌入失败时没法去原站看。
 */

const MEDIA_SEL = 'img, video, audio, canvas, picture, source';

/* 播放器 / 相册 / 灯箱 / 嵌入容器。故意不含裸 figure 与 .prose，
   否则正文和说明文字的右键复制会被一起吃掉。 */
const GUARD_SEL = [
  '.player',
  '.player-embed',
  '.player-ext',
  '.audio-player',
  '.midi-player',
  '.gallery',
  '.gallery-side',
  '.gallery-main',
  '.lightbox',
  '.player-stage',
  '.player-bar',
].join(',');

/* 作者主动放行的东西一律不拦：
   ① 用户自己导出的产物（如视频截图预览），对话框里本来就有下载按钮
   ② 站内本地资源默认带的 .asset-dl —— 这是作者决定给读者的正经原文件入口
      （dl="0" 时不输出）。它带 download 属性，右键 / 拖拽 / 修饰键点击 /
      普通左键都必须放行；
      href 里的资源路径是**有意**留在 DOM 上的，不算 ⑥ 要擦的泄漏。 */
const OFF_SEL = '[data-guard-off]';

/* 容器内这些区域仍要允许右键（复制文字 / 打开平台链接） */
const TEXT_SEL = 'figcaption, a, .gallery-caption, .player-title, .player-embed-note';

function asEl(t: EventTarget | null): Element | null {
  return t instanceof Element ? t : null;
}

function shouldGuard(t: EventTarget | null): boolean {
  const el = asEl(t);
  if (!el) return false;
  if (el.closest(OFF_SEL)) return false;
  // 命中媒体标签本身（含媒体内部的 shadow 外的子元素）
  if (el.closest(MEDIA_SEL)) return true;
  const box = el.closest(GUARD_SEL);
  if (!box) return false;
  // 容器里的文字/链接区域放行
  if (el.closest(TEXT_SEL)) return false;
  return true;
}

/** 只判断「目标就是媒体或媒体在链接里」，用于中键 / 修饰键点击 */
function isMediaLinkTarget(t: EventTarget | null): boolean {
  const el = asEl(t);
  if (!el || el.closest(OFF_SEL)) return false;
  return !!el.closest(MEDIA_SEL);
}

/** 给单个媒体元素加属性级防护（幂等，MutationObserver 会反复调用） */
function harden(el: Element): void {
  if (!(el instanceof HTMLImageElement ||
        el instanceof HTMLVideoElement ||
        el instanceof HTMLAudioElement ||
        el instanceof HTMLCanvasElement)) return;
  if (el.dataset.guardApplied) return;
  el.dataset.guardApplied = '1';
  el.setAttribute('draggable', 'false');
  if (el instanceof HTMLVideoElement) {
    /* 自绘播放器不开原生 controls，但声明了才防得住将来切回原生控件，
       也压住右键菜单里的「画中画」这一类另开视图。 */
    el.setAttribute('controlsList', 'nodownload disablePictureInPicture');
    el.disablePictureInPicture = true;
    /* 不允许把当前画面作为可拖出的独立资源 */
    el.setAttribute('playsinline', '');
  }
}

function hardenAll(root: ParentNode = document): void {
  root.querySelectorAll(MEDIA_SEL).forEach(harden);
}

/**
 * 播放器 build 完之后擦掉容器上的 data-src：
 * 路径此刻已经进了 JS 局部变量 / video.src，DOM 属性不再需要。
 * ⚠️ 只擦已 build 的，否则新插入但还没初始化的播放器会读不到 src 而变空。
 * ⚠️ 调用顺序依赖 ui.ts：必须在 initPlayers() / initAudios() 之后。
 */
function scrubSourceAttrs(): void {
  document.querySelectorAll<HTMLElement>('[data-src]').forEach((el) => {
    if (el.dataset.playerBuilt === '1' || el.dataset.audioBuilt === '1') {
      delete el.dataset.src;
    }
  });
}

let installed = false;

export function initAssetGuard(): void {
  if (installed) return;
  installed = true;

  /* 捕获阶段：控件条 / 相册按钮上即使有各自的 handler，也先在这里拦住浏览器菜单 */
  document.addEventListener('contextmenu', (e) => {
    if (shouldGuard(e.target)) e.preventDefault();
  }, true);

  document.addEventListener('dragstart', (e) => {
    if (shouldGuard(e.target)) {
      e.preventDefault();
      if (e instanceof DragEvent && e.dataTransfer) e.dataTransfer.effectAllowed = 'none';
    }
  }, true);

  /* 中键 = 新标签页；Ctrl/⌘/Shift + 左键 = 新窗口/新标签页 */
  document.addEventListener('auxclick', (e) => {
    if (e.button === 1 && shouldGuard(e.target)) e.preventDefault();
  }, true);

  document.addEventListener('click', (e) => {
    if ((e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) && shouldGuard(e.target)) {
      e.preventDefault();
    }
    /* 媒体被 <a> 包着时，普通左键也会导航到资源本身 */
    if (e.button === 0 && isMediaLinkTarget(e.target)) {
      const a = asEl(e.target)?.closest('a');
      if (a && !a.hasAttribute('download')) {
        const href = a.getAttribute('href') || '';
        if (/\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|mp3|wav|ogg|flac|m4a|mid|midi)(\?|#|$)/i.test(href)) {
          e.preventDefault();
        }
      }
    }
  }, true);

  /* 初始一遍：播放器是 JS 建的，initAssetGuard() 在 initUI 末尾调用，此时都在 DOM 里了 */
  hardenAll();
  scrubSourceAttrs();

  /* 后续动态插入的媒体（View Transitions、灯箱、截图预览、翻页）也要覆盖 */
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type !== 'childList') continue;
      m.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        harden(n);
        if (n.querySelectorAll) hardenAll(n);
      });
    }
    scrubSourceAttrs();
  });
  mo.observe(document.body, { childList: true, subtree: true });
}
