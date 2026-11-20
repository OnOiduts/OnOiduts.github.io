import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const world = z.enum(['org', 'buono', 'zilan']);

const articles = defineCollection({
  // 文章按世界存放：src/content/articles/<world>/*.md
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    world: world,
    title: z.string(),
    pubDate: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).min(1),
    excerpt: z.string(),
    cover: z.string().optional(),
    pinned: z.boolean().default(false),
    /* 原创 / 转载。
       ⚠️ 用 default('original') 而不是 optional —— 老文章没写这个字段也能过，
       且渲染时不需要到处判空。 */
    kind: z.enum(['original', 'reprint']).default('original'),
    /* 转载的话，来源是哪家（纯展示文字） */
    source: z.string().optional(),
    /* 原文链接。有就渲染成可点的「原文」链接，没有就只显示来源名。 */
    sourceUrl: z.string().optional(),
  }),
});

const projects = defineCollection({
  // 项目永远属于组织，内容不分世界
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: z.object({
    name: z.string(),
    cover: z.string(),
    created: z.coerce.date(),
    updated: z.coerce.date(),
    tags: z.array(z.string()).min(1),
    summary: z.string(),
    featured: z.boolean().default(false),
    links: z
      .array(z.object({ name: z.string(), url: z.string() }))
      .default([]),
    linksPos: z.enum(['top', 'bottom', 'inline']).default('top'),
  }),
});

export const collections = { articles, projects };
