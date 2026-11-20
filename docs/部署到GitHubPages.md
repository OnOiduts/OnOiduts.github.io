# 怎么把网站放到 GitHub Pages 上

一句话：**把项目文件推到 GitHub 上一个名字固定的仓库，然后在设置里把发布来源改成 GitHub Actions，剩下的它自己会构建、自己会发布。** 以后写完文章只要推一次代码，网站过几分钟就更新了。

配置已经放进项目里了，`.github/workflows/deploy.yml` 就是干这个的，`astro.config.mjs` 里的网址也已经对好了，你不用改任何代码。

---

## 先看清楚：仓库名字是硬规定

你现在 `astro.config.mjs` 里写的是：

```
site: 'https://onoiduts.github.io',
base: '/',
```

这叫**用户主页**，网址是 `https://onoiduts.github.io`，没有后面那一截路径。要做到这个，仓库名必须是：

```
OnOiduts.github.io
```

（GitHub 用户名是 `OnOiduts`，仓库名就照抄 `用户名.github.io`，大小写无所谓。）

⚠️ 如果你起的是别的名字，比如 `my-blog`，那网址就变成 `https://onoiduts.github.io/my-blog/`，所有图片、音频、视频的路径全会对不上，页面能开但资源全 404。真要用这种"项目页"，得同时改两行：

```js
site: 'https://onoiduts.github.io',
base: '/my-blog',   // 前面带斜杠，后面不带
```

**建议就用 `OnOiduts.github.io`，最省事，不用改配置。**

---

## 第一次部署，照着做 6 步

### 第 1 步：本地先确认能构建

在项目文件夹里（有 `package.json` 的那个）打开命令行：

```
npm install
npm run build
```

跑完会多出一个 `dist/` 文件夹，里面是生成好的网页。这一步过了，GitHub 那边基本不会出问题。

> 项目里已经附了 `package-lock.json`（锁住依赖版本），部署脚本里也写明了 `package-manager: npm`。两个都在，CI 装依赖不会出问题。如果你是从旧包升级的，记得把这两个文件一起推上去——只覆盖 `deploy.yml` 也能过，但版本不锁。

### 第 2 步：在 GitHub 建仓库

- 右上角 `+` → `New repository`
- 仓库名填 `OnOiduts.github.io`
- 选 **Public**（私人仓库要开 Pages 得付费）
- **不要**勾 "Add a README"、不要选 .gitignore 模板、不要选 license —— 空仓库最省事，免得和你本地文件打架
- 点 Create repository

### 第 3 步：把本地文件推上去

在项目文件夹里：

```
git init
git remote add origin https://github.com/OnOiduts/OnOiduts.github.io.git
git add .
git commit -m "第一次部署"
git branch -M main
git push -u origin main
```

如果你本地已经是 `master` 分支（当前这份就是），把上面两行的 `main` 换成 `master` 就行 —— 部署脚本 `main` 和 `master` 都认，不用特地改分支名。

`.gitignore` 已经排除了 `node_modules/`、`dist/`、`.astro/`，这些不会传上去，仓库是干净的。

> **用 GitHub Desktop 的话**：上面这几行命令换成「把解压出来的文件复制进仓库文件夹 → 左下角填提交说明 → 点 Commit → 再点顶部的 Push origin」。**提交和推送是两下，只提交不推，线上什么都不会变**。复制时别漏了隐藏文件夹 `.github/`，里面的 `deploy.yml` 就是自动部署的开关。第 3 步里的 `package-lock.json` 也要一起放进去。

### 第 4 步：改一个关键设置（最容易漏）

进仓库网页 → **Settings** → 左边 **Pages** → 找到 **Build and deployment** → **Source** 这一项：

```
选 GitHub Actions        ✅
不要选 Deploy from a branch   ❌
```

选错的话，GitHub 会拿仓库里的源码当网页，打开就是 404 或者一堆文件名。

### 第 5 步：让它跑一次

推完代码应该自动开始跑。想确认或手动再来一次：

- 仓库顶部 **Actions** 标签
- 左边选 `Deploy to GitHub Pages`
- 点 **Run workflow** → 绿色的 **Run workflow**

第一次大概 1～3 分钟，等两个小勾都变绿。

### 第 6 步：打开网站

```
https://onoiduts.github.io
```

浏览器按一次 `Ctrl + Shift + R` 强制刷新，避开旧缓存。

---

## 以后怎么更新文章

```
改完 .md 文件 → git add . → git commit -m "写了新文章" → git push
```

推完自动构建、自动发布，不用再动 GitHub 网页。写作台是本地工具，导出的 `.md` 放进 `src/content/blog/` 再推就行。

---

## 出问题先查这几条

| 现象 | 多半是 |
|---|---|
| 打开 404 / 显示仓库文件列表 | 发布源没选 **GitHub Actions**，或 Actions 还没跑完 |
| 页面能开，图片音频视频全裂 | 仓库名不是 `OnOiduts.github.io`，或者项目页忘了改 `base` |
| Actions 一直没触发 | 推的分支不在 `main`/`master`，或 `deploy.yml` 没传上去（`.github/` 是隐藏文件夹，别漏） |
| Actions 红了 | 点进去看日志，最常见是 `npm run build` 本地就报错；先把第 1 步跑通 |
| **build 6 秒就红，日志写 `No lockfile found` / `Please specify your preferred "package-manager"`** | 见下面这一节 |
| 部署成功但看到的还是旧页面 | 浏览器缓存，`Ctrl+Shift+R`；或看 Actions 里部署的到底是哪次提交 |
| 改了文章没变化 | Astro 开发时改插件不会热重编已经编译过的 markdown，线上是全新构建，不会有这个问题；确认 push 成功即可 |

### 最常见的红叉：`No lockfile found`

**长这样**：`build` 几秒钟就失败，`deploy` 那步被跳过；展开 `Install, build, and upload your site` → `Check lockfiles`，日志是：

```
No lockfile found.
Please specify your preferred "package-manager" in the action configuration.
Error: Process completed with exit code 1.
```

**为什么**：官方 Astro Action 要先判断你这个项目用 npm、yarn 还是 pnpm，判断依据是仓库里的锁文件（`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`）。**一个都没有时它不会自动当 npm 处理，而是直接报错** —— 这是官方 Action 的行为，不是文章写错、也不是 Pages 设置错了。

**新包里已经两层都补好了**：

1. `.github/workflows/deploy.yml` 里加了 `package-manager: npm`，明确告诉它用 npm；
2. 附了 `package-lock.json`，锁住依赖版本，Action 也能自己认出来。

**已经在推的仓库怎么修（GitHub Desktop）**：

1. 把新包里的 `.github/workflows/deploy.yml` 复制进仓库，**覆盖同名文件**；顺手把 `package-lock.json` 也放进仓库根目录（和 `package.json` 放一起）
2. Desktop 左下角填提交说明（比如「修好构建：指定 npm」）→ **Commit** → 顶部 **Push origin**
3. 推送会自动触发一次新的构建，等它变绿就行

⚠️ **别直接点 Actions 右上角的 Re-run jobs**：代码没改，重跑还是同一个错。另外这次失败**没有部署任何东西**，线上还是之前的状态，不用回滚。

过了这一关，Action 才会真正开始装依赖、跑 `astro build`。**如果新日志在 `npm install` 或 `astro build` 阶段又报错，把日志贴出来**，那就是另一类问题了。

---

## 几个还得知道的限制

- **GitHub Pages 是纯静态**，发不了响应头、做不了签名链接。之前做的「拦右键 / 拦拖拽 / 拦另开窗口」只是让随手保存费点劲，`public/` 里的每个文件本来就能直接输网址下载 —— 母版、原稿、未压缩视频别放进去。
- **仓库是公开的**：里面的图片、音频、文章源文件别人都能在 GitHub 网页上直接看。私密仓库开 Pages 要付费计划。
- **想换成自己的域名**：Settings → Pages → Custom domain 填域名，再按提示加 DNS 记录；同时把 `astro.config.mjs` 的 `site` 改成新域名。
- 项目里放了一个空的 `public/.nojekyll`：Astro 会生成 `_astro` 这种下划线开头的目录，万一以后改成"从分支部署"，GitHub 的 Jekyll 会把它吞掉；有这个文件就不会。用 Actions 部署时用不上它，留着没坏处。
- 本地看效果仍是 `npm run dev`；`npm run preview` 看的是构建后的样子，跟线上最接近。

---

## 部署完顺手核对

- [ ] 首页、博客列表、文章页都能开
- [ ] 图片、单图说明文字、相册翻页正常
- [ ] 音频条能播、频谱会跳；MIDI 能播（下载按钮默认不显示，只有你勾过才有）
- [ ] 视频全屏占满屏、鼠标停下控件条淡出
- [ ] B站 / 网易云嵌入能加载
- [ ] 右键、拖拽、中键另开被拦，但正文文字能正常选中复制
