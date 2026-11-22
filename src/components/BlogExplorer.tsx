/**
 * 博客页：搜索框 + 标签 + 文章卡片。
 * 搜索当前世界文章标题 + 匹配用户别名；世界切换由 nanostores 驱动，URL 不变。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { $worldSwitchSeq, setWorldQuiet, switchWorld } from '../scripts/world';
import { useWorld } from '../scripts/useWorld';
import {
  IDENTITIES,
  PERSONAS,
  WORLD_IDS,
  matchPersona,
  placeholderFor,
  type WorldId,
} from '../data/identities';
import { byPinyin } from '../utils/format';
import ArticleCard, { type ArticleMeta } from './ArticleCard';

interface Props {
  articles: ArticleMeta[];
}

export default function BlogExplorer({ articles }: Props) {
  const world = useWorld();
  const [q, setQ] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<'freq' | 'pinyin'>('freq');
  const [asc, setAsc] = useState(false);
  const [moreTags, setMoreTags] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const userHitRef = useRef<HTMLButtonElement>(null);
  /* 中文输入法正在选字时按回车（比如打「孜岚」的 zi'lan 按回车上屏），
     这一下是给输入法的，不是提交搜索，更不能顺手把世界切走。 */
  const composingRef = useRef(false);

  // 进入时：URL 上的 world 静默同步（不算用户主动切换），tag 应用到筛选
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const wp = sp.get('world');
    if (wp && (WORLD_IDS as string[]).includes(wp)) setWorldQuiet(wp as WorldId);
    const t = sp.get('tag');
    if (t) setTags([t]);
  }, []);

  // 只有用户主动切世界才重置筛选；文章页强制同步 / URL 同步不算，否则刚带过来的 tag 会被冲掉
  const seenSeq = useRef($worldSwitchSeq.get());
  useEffect(() => {
    if ($worldSwitchSeq.get() === seenSeq.current) return;
    seenSeq.current = $worldSwitchSeq.get();
    setQ('');
    setTags([]);
    setMoreTags(false);
  }, [world]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const inWorld = useMemo(
    () => articles.filter((a) => a.world === world),
    [articles, world]
  );

  // 标签体系：每个世界独立
  const tagList = useMemo(() => {
    const freq = new Map<string, number>();
    inWorld.forEach((a) => a.tags.forEach((t) => freq.set(t, (freq.get(t) ?? 0) + 1)));
    const list = Array.from(freq.entries());
    list.sort((x, y) =>
      sortMode === 'freq'
        ? y[1] - x[1] || byPinyin(x[0], y[0])
        : byPinyin(x[0], y[0])
    );
    if (asc) list.reverse();
    return list.map(([name, count]) => ({ name, count }));
  }, [inWorld, sortMode, asc]);

  const TAG_LIMIT = isMobile ? 5 : 10;
  const visibleTags = moreTags ? tagList : tagList.slice(0, TAG_LIMIT);

  // 搜索：标题匹配 + 用户别名；在当前世界搜当前世界主人名不显示入口
  const hitUser = useMemo(() => {
    const p = matchPersona(q);
    if (!p) return null;
    if (p.id === world) return null; // 当前世界的主人，不再给入口
    return p;
  }, [q, world]);

  // 列表：标签（且优先，降级为或）+ 搜索，后操作者在上层
  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    let out = inWorld;
    if (tags.length) {
      const and = out.filter((a) => tags.every((t) => a.tags.includes(t)));
      out = and.length ? and : out.filter((a) => a.tags.some((t) => tags.includes(t)));
    }
    if (kw) out = out.filter((a) => a.title.toLowerCase().includes(kw));
    return [...out].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime();
    });
  }, [inWorld, tags, q]);

  const toggleTag = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  /* 瀑布流分列：移动端单列，桌面端两列。
     按 index % 2 轮流投放 —— 视觉上是「第 1 行左、第 1 行右、第 2 行左…」，
     符合从上到下、从左到右的阅读顺序。 */
  const columns = useMemo(() => {
    if (isMobile) return [list];
    const cols: ArticleMeta[][] = [[], []];
    list.forEach((a, i) => cols[i % 2].push(a));
    return cols;
  }, [list, isMobile]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();                       // 表单没有 action，不拦会刷新整页
    if (composingRef.current) return;         // 输入法选字中的回车，不算提交
    /* 搜到人设别名、下方已经出现「用户：XXX」入口时，按回车 = 点那个入口。
       以前这里只 preventDefault，回车毫无反应，只能拿鼠标点按钮 —— 现在两条路
       走同一个 switchWorld，连动效的圆心（userHitRef）都一致。
       没命中人设时按回车什么都不做，仍然只是实时筛选文章，不误切世界。 */
    if (hitUser) switchWorld(hitUser.id, userHitRef.current);
  };

  return (
    <>
      <div className="search-wrap">
        <form onSubmit={submit} role="search">
          <input
            className="search-input"
            value={q}
            placeholder={placeholderFor(world)}
            onChange={(e) => setQ(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            aria-label="搜索"
          />
          <button className="search-btn" type="submit" aria-label="搜索">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
        </form>

        {/* 用户入口：内联在搜索框下方，会把它下面的内容推开，
            而不是浮在上面 —— 这样标签栏永远点得到。
            文章结果不在这里重复显示，直接走下面的列表。 */}
        {hitUser && (
          <div className="search-user-slot">
            <button
              className="search-user-item"
              ref={userHitRef}
              type="button"
              onClick={() => switchWorld(hitUser.id, userHitRef.current)}
              title="点这里，或在搜索框里按回车，都能切换世界"
              aria-keyshortcuts="Enter"
            >
              用户：{hitUser.name}
            </button>
          </div>
        )}
      </div>

      <div className="tag-bar">
        <div className="tag-list">
          {visibleTags.map(({ name, count }) => (
            <button
              key={name}
              type="button"
              className={`tag${tags.includes(name) ? ' on' : ''}`}
              onClick={() => toggleTag(name)}
            >
              {name}
              <span className="faint">{count}</span>
            </button>
          ))}
          {tagList.length > TAG_LIMIT && (
            <button className="tag" type="button" onClick={() => setMoreTags((v) => !v)}>
              {moreTags ? '收起' : `更多 +${tagList.length - TAG_LIMIT}`}
            </button>
          )}
        </div>

        <div className="tag-tools">
          <button
            className="btn-ghost"
            type="button"
            onClick={() => setSortMode((m) => (m === 'freq' ? 'pinyin' : 'freq'))}
          >
            {sortMode === 'freq' ? '频率' : '拼音'}
          </button>
          <button className="btn-ghost" type="button" onClick={() => setAsc((v) => !v)}>
            {asc ? '升序' : '降序'}
          </button>
          {tags.length > 0 && (
            <button className="btn-ghost" type="button" onClick={() => setTags([])}>
              清空
            </button>
          )}
        </div>
      </div>

      {list.length === 0 ? (
        <div className="terminal empty-state">
          <div>&gt; 这里还没有文章</div>
          <div>&gt; 等待更新...</div>
        </div>
      ) : (
        /* 瀑布流：左右两列各自独立往下堆，卡片保持自身高度、错落排布。
           用 JS 分列而不是 CSS columns —— columns 是「填满第一列再填第二列」，
           顺序会变成 1,2,3 全在左边、4,5,6 全在右边，读起来是竖着走的；
           这里 index % 2 才是「从上到下、从左到右」的阅读顺序。 */
        <div className="masonry" style={{ marginTop: '24px' }}>
          {columns.map((col, ci) => (
            <div className="masonry-col" key={ci}>
              {col.map((a) => (
                <ArticleCard key={a.slug} a={a} onTag={toggleTag} />
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export type { ArticleMeta };
export { IDENTITIES, PERSONAS };
