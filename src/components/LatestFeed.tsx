/**
 * 首页最新文章：内容跟世界变，介绍文字和 B 不变。
 * 宽屏 5 篇，窄屏 3 篇；标题 + 摘要 + 日期上下排，整条可点。
 */
import { useEffect, useMemo, useState } from 'react';
import { useWorld } from '../scripts/useWorld';
import { IDENTITIES } from '../data/identities';
import { fmtDate } from '../utils/format';
import type { ArticleMeta } from './ArticleCard';

interface Props {
  articles: ArticleMeta[];
}

export default function LatestFeed({ articles }: Props) {
  const world = useWorld();
  const [n, setN] = useState(5);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const on = () => setN(mq.matches ? 3 : 5);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const list = useMemo(
    () =>
      articles
        .filter((a) => a.world === world)
        /* ⚠️ 本轮：首页「最新文章」—— pinned 一律不参与排序。
           这个区块的语义就是「最新」，置顶文章在这里不该有任何特权，
           否则最新发布的文章会被旧置顶文挤到下面，名不副实。
           纯按发布日期降序，置顶只在 /blog 列表页生效。 */
        .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
        .slice(0, n),
    [articles, world, n]
  );

  if (!list.length) {
    return (
      <div className="terminal">
        <div>&gt; 这里还没有文章</div>
        <div>&gt; 等待更新...</div>
      </div>
    );
  }

  return (
    <div className="latest-list">
      {list.map((a) => (
        <a className="latest-item" key={a.slug} href={a.url}>
          <div className="latest-title">{a.title}</div>
          <div className="latest-excerpt">{a.excerpt}</div>
          <div className="latest-date">
            <span className={`kind-badge${a.kind === 'reprint' ? ' is-reprint' : ''}`}>
              {a.kind === 'reprint' ? '转载' : '原创'}
            </span>
            {fmtDate(a.pubDate)}
            {a.updated ? ` · 更新于 ${fmtDate(a.updated)}` : ''}
          </div>
        </a>
      ))}
      <div className="latest-hint faint t-xs">
        当前：{IDENTITIES[world].name}
      </div>
    </div>
  );
}
