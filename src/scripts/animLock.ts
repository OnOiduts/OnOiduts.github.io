/**
 * 全局过渡锁 —— 保证「任何时刻只有一个过渡/进场动画在跑」。
 *
 * 规则（文档第七条）：
 * ① 播放中必须播完，不能被跳过 / 打断；
 * ② 播放中被再次触发 → 忽略，不叠加、不错乱；
 * ③ 只管「过渡动画」和「进场动画」：板块切换过渡、世界切换过渡、内容进场；
 *    不管悬停动画、漂浮等持续性动效（那些本来就该随时响应）。
 *
 * ⚠️ 锁必须是模块级的单例：
 *    放在各自函数闭包里的话，一旦模块被重复求值（HMR / 组件重挂载），
 *    每个闭包都有自己的布尔量，等于没有锁。
 */

type Slot = 'page' | 'world';

/* 每个槽位独立计时，互不抢占：
   板块切换和世界切换是两类动画，但同一时刻只允许其中之一在播，
   所以这里用一个「总闸」+ 一个「当前占用者」来判定。 */
let busyUntil = 0;
let owner: Slot | null = null;

/**
 * 申请播放一段过渡动画。
 * @param slot 动画类型
 * @param ms 时长（含余量），到点自动解锁
 * @returns 是否抢到；false 表示此刻有别的动画在播，调用方应直接 return
 */
export function claimTransition(slot: Slot, ms: number): boolean {
  const now = performance.now();
  if (now < busyUntil) return false;
  busyUntil = now + ms;
  owner = slot;
  return true;
}

/** 动画提前结束（比如 animationend 提前到达）时主动释放 */
export function releaseTransition(slot: Slot): void {
  if (owner === slot) {
    busyUntil = 0;
    owner = null;
  }
}

/** 当前是否有过渡在播（供测试与调试用） */
export function isTransitionBusy(): boolean {
  return performance.now() < busyUntil;
}

/** 供测试读取的剩余时长（ms） */
export function transitionRemaining(): number {
  return Math.max(0, busyUntil - performance.now());
}
