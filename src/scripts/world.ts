/**
 * 世界状态 —— URL 不变，只是前端状态。
 * 明暗是持久化的；世界在同一个标签页内续上（sessionStorage），
 * 刷新不再强制回组织，只有新开标签页 / 会话结束才回到组织。
 */
import { atom } from 'nanostores';
import { WORLD_IDS, type WorldId } from '../data/identities';
import { claimTransition } from './animLock';

export const $world = atom<WorldId>('org');

/**
 * 只在「用户主动切换世界」时递增。
 * 文章页强制同步世界、URL 带 world 参数同步世界都不算 —— 那类同步不该重置筛选条件。
 */
export const $worldSwitchSeq = atom(0);

/**
 * 静默同步世界：不播动效、不计入用户切换次数。
 * 用于进入文章详情页 / 从 URL 恢复世界。
 */
export function setWorldQuiet(next: WorldId): void {
  if ($world.get() === next) return;
  $world.set(next);
  document.documentElement.dataset.world = next;
}

/* 故障动效总时长：本轮要求「再快点、干脆利落」，1 秒 → 0.6 秒。
   光晕 .7s、故障抖动 .28s×2，切色点从 500ms 提前到 260ms。 */
const GLITCH_MS = 600;
/* 动效中段切色的时刻：原 500ms。整体缩到 0.6 秒后按比例提前。 */
const SWITCH_AT = 260;
let switching = false;

/** 触发一次世界切换（含 1 秒动效） */
export function switchWorld(next: WorldId, origin?: HTMLElement | null): void {
  const cur = $world.get();
  if (switching || cur === next) return;
  /* 全局过渡锁：此刻若已有别的过渡（板块切换 / 上一次世界切换）在播，
     直接忽略这次触发 —— 不叠加、不抢占、不打断。 */
  if (!claimTransition('world', GLITCH_MS + 300)) return;
  switching = true;

  const scrollY = window.scrollY; // 切换世界保持当前位置
  const isMobile = window.matchMedia('(max-width: 900px)').matches;
  const backToOrg = next === 'org';

  /* 故障感：进入用户和回组织都加（原来只有进入时有解码）。 */
  if (backToOrg) {
    playScan();
  } else {
    playBurst(origin);
  }

  window.setTimeout(() => {
    $world.set(next);
    document.documentElement.dataset.world = next;
    $worldSwitchSeq.set($worldSwitchSeq.get() + 1);
    window.dispatchEvent(new CustomEvent('worldchange', { detail: { world: next } }));
    window.scrollTo({ top: scrollY, behavior: 'auto' });
    switching = false;

    /* 故障感：颜色错位 + 抖动，不放字符解码（本轮去掉了）。
       放在世界切换之后，留出 90ms 让 React 渲染完 ——
       提前播的话打在旧节点上，新内容渲染出来时动效已经结束了。 */
    /* 偏色：**必须在世界切完之后再启动** —— 这一层的颜色就是 var(--accent)，
       提前 260ms 启动的话染的还是上一个世界的颜色，等于「偏错色」。 */
    playTint();

    if (!isMobile) {
      window.setTimeout(playGlitch, 90);
    }
  }, SWITCH_AT); // 动效中段切色，让颜色过渡与光效重叠
}

/**
 * 进入用户：一圈很淡的扩散环，从「用户：XXX」那一行扩散出来。
 *
 * 三个要点：
 * ① 圆心必须是点击处（origin 的中心）—— 原来有时拿不到 origin 就退化成
 *    window.innerWidth/2，也就是「从屏幕中间生出一坨光」，很生硬。
 *    现在 origin 拿不到时，退而求其次找 .search-user-item，再不行才用视口中心。
 * ② 起始尺寸小（60px）、整体很淡（CSS 里去掉了白核和高亮 box-shadow），
 *    像「波前扫过」而不是「光球炸开」。
 * ③ 不放字符解码（本轮已去掉），只留颜色错位 + 抖动的故障感。
 */
function playBurst(origin?: HTMLElement | null) {
  const el = document.createElement('div');
  el.className = 'world-burst';
  /* 起始尺寸：小一点，扩散到 scale(46) 时约 2.7 倍视口宽，够覆盖全屏 */
  el.style.width = '60px';
  el.style.height = '60px';

  const src = origin ?? document.querySelector<HTMLElement>('.search-user-item');
  const r = src?.getBoundingClientRect();
  el.style.left = `${r ? r.left + r.width / 2 : window.innerWidth / 2}px`;
  el.style.top = `${r ? r.top + r.height / 2 : window.innerHeight / 2}px`;

  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 1200);
}

/** 世界转场偏色：整屏短暂偏成当前（已切完的）世界强调色，再褪回 */
function playTint(): void {
  const el = document.getElementById('world-tint');
  if (!el) return;
  el.classList.remove('on');
  void el.offsetWidth; // 强制重排：连续切换时动画才会重新播
  el.classList.add('on');
  window.setTimeout(() => el.classList.remove('on'), 600);
}

/** 回组织：一条发光的水平线从上往下扫过全屏 */
function playScan() {
  const el = document.createElement('div');
  el.className = 'world-scan';
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 1000);
}

/**
 * 故障感：RGB 分离（.app-glitch）+ 横切错位条（.glitch-bars）。
 *
 * ⚠️ 挂在 #app 上，但 .app-glitch 里不能用 transform / filter ——
 *    #app 内有导航栏和目录两个 position: fixed 元素，
 *    一旦创建包含块，这 0.5 秒里它们会脱离视口顶部跟着滚走。
 *    详见 global.css 里的注释。
 */
function playGlitch(): void {
  const app = document.getElementById('app');
  if (app) {
    app.classList.remove('app-glitch');
    void app.offsetWidth; // 强制重排，连续切换时动画才会重新播
    app.classList.add('app-glitch');
    window.setTimeout(() => app.classList.remove('app-glitch'), 1100);
  }

  /* 横切错位条：3~5 条，随机高度和位置，0.5 秒后移除 */
  const box = document.createElement('div');
  box.className = 'glitch-bars';
  box.setAttribute('aria-hidden', 'true');
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const bar = document.createElement('div');
    bar.className = 'glitch-bar';
    bar.style.top = `${Math.random() * 92}%`;
    bar.style.height = `${2 + Math.random() * 14}px`;
    bar.style.animationDelay = `${(Math.random() * 120).toFixed(0)}ms`;
    box.appendChild(bar);
  }
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), 800);
}

/** 供首页的 B 使用：拆散重组 1 秒后回组织 */
/** 点击 B → 回组织。
    注意：b-shatter 这个 class 的加/删由 ui.ts 的 initB 统一管（那里有「只播一次」的锁），
    这里不要再动它 —— 两处各起一个定时器会把动画打断。 */
export function triggerB(origin?: HTMLElement | null) {
  switchWorld('org', origin);
}

/* ------------------------------------------------------------------
   站内导航保持世界，F5 / Ctrl+R 刷新也保持世界。
   世界是前端状态，不写进 URL；用 sessionStorage 在同一次浏览里续上，
   只有新开标签页 / 会话结束（sessionStorage 被清空）才回到组织。
   ------------------------------------------------------------------ */
const WKEY = 'onoiduts-world';

export function initWorld() {
  const saved = sessionStorage.getItem(WKEY) as WorldId | null;
  if (saved && saved !== 'org' && WORLD_IDS.includes(saved)) {
    setWorldQuiet(saved);
  }

  $world.subscribe((w) => {
    try {
      sessionStorage.setItem(WKEY, w);
    } catch {
      /* 隐私模式下写不了就只活在内存里 */
    }
  });
}
