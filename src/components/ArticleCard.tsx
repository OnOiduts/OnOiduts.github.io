/** 文章卡片：封面（有图才显示）+ 标题 + 日期（两行）+ 标签（最多 3 个 +「+N」）+ 摘要（一行）；整张可点 */
import { fmtDate } from '../utils/format';

export interface ArticleMeta {
  slug: string;
  world: 'org' | 'buono' | 'zilan';
  title: string;
  pubDate: string;
  updated?: string;
  tags: string[];
  excerpt: string;
  cover?: string;
  pinned?: boolean;
  url: string;
  /** 原创 / 转载。老数据没这个字段时按「原创」处理。 */
  kind?: 'original' | 'reprint';
  /** 转载来源名 */
  source?: string;
  /** 原文链接 */
  sourceUrl?: string;
}

interface Props {
  a: ArticleMeta;
  onTag?: (tag: string) => void;
}

export default function ArticleCard({ a, onTag }: Props) {
  const shown = a.tags.slice(0, 3);
  const rest = a.tags.length - shown.length;

  return (
    /* ⚠️ 本轮：卡片**不再有进场动画**（用户要求整个去掉）。
       原来是 `card reveal`（配合 IntersectionObserver 逐个淡入），
       现在直接显示，不再逐个出现。 */
    <a className={`card${a.pinned ? ' pinned' : ''}`} href={a.url}>
      {a.cover && <img className="cover" src={a.cover} alt="" loading="lazy" />}
      <div className="card-title">{a.title}</div>
      <div className="card-date">
        <div>
          {/* ⚠️ 徽标放在日期行里而不是标题旁：标题是两行省略，
              旁边塞东西会把它挤成一行。日期行本来就短，放得下。 */}
          <span className={`kind-badge${a.kind === 'reprint' ? ' is-reprint' : ''}`}>
            {a.kind === 'reprint' ? '转载' : '原创'}
          </span>
          {fmtDate(a.pubDate)}
        </div>
        {a.updated && <div>更新于 {fmtDate(a.updated)}</div>}
      </div>
      <div className="card-tags">
        {shown.map((t) => (
          <span
            key={t}
            className="tag tag-static"
            onClick={(e) => {
              if (!onTag) return;
              e.preventDefault();
              e.stopPropagation();
              onTag(t);
            }}
          >
            {t}
          </span>
        ))}
        {rest > 0 && <span className="tag tag-static">+{rest}</span>}
      </div>
      {/* data-tip：单行省略号会截断，悬停时用全站样式的 tooltip 显示完整文字。
          是否真的被截断由 JS 判断（scrollHeight/scrollWidth 对比），没截断就不弹。 */}
      <div className="card-excerpt" data-tip={a.excerpt}>{a.excerpt}</div>
    </a>
  );
}
