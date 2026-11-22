/**
 * 身份体系 —— 三个身份都是同一个人。
 * 世界 0 = 组织（主面），世界 1/2 = 人设（成员）。
 * 别名只用于搜索框匹配，不对外显示；人设名才是显示名。
 */

export type WorldId = 'org' | 'buono' | 'zilan';

export interface Identity {
  id: WorldId;
  /** 显示名 */
  name: string;
  /** 组织不是人设，不进入成员搜索结果 */
  isPersona: boolean;
  /** 别名：忽略大小写匹配，与人设名一起构成四种标识 */
  aliases: string[];
  /** 搜索框占位符里的名字 */
  displayName: string;
  /** 一句话定位（关于页用） */
  tagline: string;
}

export const ORG: Identity = {
  id: 'org',
  name: 'OnOiduts工业',
  isPersona: false,
  aliases: [],
  displayName: 'OnOiduts工业',
  tagline: '个人品牌 · 瞎搞的小工具',
};

export const BUONO: Identity = {
  id: 'buono',
  name: '波萝Buono',
  isPersona: true,
  // 人设名 / 指定单词 / 指定拼音 / MC ID
  aliases: ['波萝Buono', '波萝', 'Buono', 'boluo', 'XxBo_LuoxX'],
  displayName: '波萝Buono',
  tagline: '小游戏实况主 · 捣鼓 AI 小工具 · 研究直播',
};

export const ZILAN: Identity = {
  id: 'zilan',
  name: '孜岚',
  isPersona: true,
  aliases: ['孜岚', 'Zeelan', 'zilan', 'Xiao_Zi_Lan'],
  displayName: '孜岚',
  tagline: '音 MAD 作者 · 虚拟主播切片 man · 转载虚拟区 · 写曲子',
};

export const IDENTITIES: Record<WorldId, Identity> = {
  org: ORG,
  buono: BUONO,
  zilan: ZILAN,
};

export const PERSONAS: Identity[] = [BUONO, ZILAN];

export const WORLD_IDS: WorldId[] = ['org', 'buono', 'zilan'];

/** 搜索框占位符：`> 搜索 XXX` */
export function placeholderFor(world: WorldId): string {
  return `> 搜索 ${IDENTITIES[world].displayName}`;
}

/**
 * 关键词 → 命中的人设。
 * 规则：忽略大小写；组织名不当别名，只当普通关键词搜文章；
 * 在当前世界搜当前世界主人名 → 不返回该用户入口（由调用方处理）。
 */
export function matchPersona(query: string): Identity | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const p of PERSONAS) {
    for (const a of [p.name, ...p.aliases]) {
      if (a.toLowerCase() === q) return p;
    }
  }
  return null;
}
