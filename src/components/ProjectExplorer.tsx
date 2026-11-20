/**
 * 项目页：搜索框（只搜项目标题，不能切世界）+ 标签 + 时间线。
 * 内容不分世界，只变色。
 */
import { useEffect, useMemo, useState } from 'react';
import { byPinyin, fmtDate } from '../utils/format';

export interface ProjectMeta {
  slug: string;
  name: string;
  cover: string;
  created: string;
  updated: string;
  tags: string[];
  summary: string;
  featured: boolean;
  url: string;
}

interface Props {
  projects: ProjectMeta[];
}

const pad = (n: number) => String(n).padStart(2, '0');

export default function ProjectExplorer({ projects }: Props) {
  const [q, setQ] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<'freq' | 'pinyin'>('freq');
  const [asc, setAsc] = useState(false);
  const [moreTags, setMoreTags] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [closedYears, setClosedYears] = useState<Set<string>>(new Set());
  const [closedMonths, setClosedMonths] = useState<Set<string>>(new Set());

  // 从详情页点标签回来：应用 URL 上的 tag
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tag');
    if (t) setTags([t]);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const tagList = useMemo(() => {
    const freq = new Map<string, number>();
    projects.forEach((p) => p.tags.forEach((t) => freq.set(t, (freq.get(t) ?? 0) + 1)));
    const list = Array.from(freq.entries());
    list.sort((x, y) =>
      sortMode === 'freq' ? y[1] - x[1] || byPinyin(x[0], y[0]) : byPinyin(x[0], y[0])
    );
    if (asc) list.reverse();
    return list.map(([name, count]) => ({ name, count }));
  }, [projects, sortMode, asc]);

  const TAG_LIMIT = isMobile ? 5 : 10;
  const visibleTags = moreTags ? tagList : tagList.slice(0, TAG_LIMIT);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    let out = projects;
    if (tags.length) {
      const and = out.filter((p) => tags.every((t) => p.tags.includes(t)));
      out = and.length ? and : out.filter((p) => p.tags.some((t) => tags.includes(t)));
    }
    if (kw) out = out.filter((p) => p.name.toLowerCase().includes(kw));
    return [...out].sort(
      (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()
    );
  }, [projects, tags, q]);

  // 年 → 月 → 项目
  const tree = useMemo(() => {
    const years = new Map<string, Map<string, ProjectMeta[]>>();
    list.forEach((p) => {
      const d = new Date(p.created);
      const y = String(d.getFullYear());
      const m = String(d.getMonth() + 1);
      if (!years.has(y)) years.set(y, new Map());
      const mm = years.get(y)!;
      if (!mm.has(m)) mm.set(m, []);
      mm.get(m)!.push(p);
    });
    return Array.from(years.entries())
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([y, mm]) => ({
        year: y,
        months: Array.from(mm.entries())
          .sort((a, b) => Number(b[0]) - Number(a[0]))
          .map(([m, items]) => ({ month: m, items })),
      }));
  }, [list]);

  // 默认展开：最新年份 + 最新月份（其余折叠）
  useEffect(() => {
    if (!tree.length) return;
    const latestYear = tree[0].year;
    const latestMonth = tree[0].months[0]?.month;
    setClosedYears(new Set(tree.slice(1).map((t) => t.year)));
    setClosedMonths(
      new Set(tree[0].months.slice(1).map((m) => `${latestYear}-${m.month}`))
    );
    void latestMonth;
  }, [tree]);

  const toggleYear = (y: string) =>
    setClosedYears((prev) => {
      const n = new Set(prev);
      n.has(y) ? n.delete(y) : n.add(y);
      return n;
    });
  const toggleMonth = (key: string) =>
    setClosedMonths((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  const toggleTag = (t: string) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  if (!projects.length) {
    return (
      <div className="terminal empty-state">
        <div>&gt; 这里还没有项目</div>
        <div>&gt; 等待更新...</div>
      </div>
    );
  }

  return (
    <>
      <div className="search-wrap">
        <form
          onSubmit={(e) => {
            e.preventDefault();
          }}
          role="search"
        >
          <input
            className="search-input"
            value={q}
            placeholder="> 搜索项目"
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索项目"
          />
          <button className="search-btn" type="submit" aria-label="搜索">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
        </form>

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

      {!list.length ? (
        <div className="terminal empty-state">
          <div>&gt; 这里还没有项目</div>
          <div>&gt; 等待更新...</div>
        </div>
      ) : (
        <div className="timeline">
          {tree.map(({ year, months }) => {
            const yearClosed = closedYears.has(year);
            return (
              <div className="tl-year" key={year}>
                <button className="tl-node" type="button" onClick={() => toggleYear(year)}>
                  <span className="tl-dot"></span>
                  {year}
                  <span className="tl-fold faint">{yearClosed ? '+' : '−'}</span>
                </button>
                {!yearClosed && (
                  <div className="tl-line">
                    {months.map(({ month, items }) => {
                      const key = `${year}-${month}`;
                      const monthClosed = closedMonths.has(key);
                      return (
                        <div className="tl-month" key={key}>
                          <button
                            className="tl-month-node"
                            type="button"
                            onClick={() => toggleMonth(key)}
                          >
                            {month}月
                            <span className="tl-fold faint">
                              {items.length} {monthClosed ? '+' : '−'}
                            </span>
                          </button>
                          {!monthClosed && (
                            <div className="tl-items">
                              {items.map((p) => (
                                <a className="card proj-row" key={p.slug} href={p.url}>
                                  <img className="proj-thumb" src={p.cover} alt="" loading="lazy" />
                                  <div className="proj-main">
                                    <div className="proj-name">
                                      {p.name}
                                      {p.featured && <span className="proj-star">★</span>}
                                    </div>
                                    <div className="card-date">
                                      <div>创建 {fmtDate(p.created)}</div>
                                      <div>更新 {fmtDate(p.updated)}</div>
                                    </div>
                                    <div className="card-tags">
                                      {p.tags.map((t) => (
                                        <span className="tag tag-static" key={t}>
                                          {t}
                                        </span>
                                      ))}
                                    </div>
                                    <div className="card-excerpt" data-tip={p.summary}>{p.summary}</div>
                                  </div>
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export { pad };
export type { ProjectMeta as PMeta };
