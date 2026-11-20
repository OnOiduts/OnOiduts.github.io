@echo off
chcp 65001 >nul
setlocal
title OnOiduts - 本地测试

REM 切换到本文件所在目录（这样双击运行时不管当前路径在哪都对）
cd /d "%~dp0"

REM 如果把本脚本放到了外层目录（和 onoiduts 文件夹同级），自动进到项目里
if not exist "package.json" (
  if exist "onoiduts\package.json" (
    cd onoiduts
    echo   [..] 已定位到项目目录：%CD%
  )
)

echo.
echo   ==========================================
echo    OnOiduts工业 · 本地测试
echo   ==========================================
echo    目录：%CD%
echo.

REM 支持参数：start.bat build（构建）/ install（重装依赖）/ clean（清 Astro 缓存）
if /i "%~1"=="build" goto :build
if /i "%~1"=="install" goto :install
if /i "%~1"=="clean" goto :clean

REM ---------- 1. 检查 Node / npm ----------
where node >nul 2>nul
if errorlevel 1 goto :nonode
where npm  >nul 2>nul
if errorlevel 1 goto :nonpm

REM node -v 输出形如 v20.19.5；delims=v. 取第一段即主版本号
set "NODE_MAJOR="
for /f "delims=v." %%a in ('node -v') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR set "NODE_MAJOR=0"

if %NODE_MAJOR% LSS 20 (
  echo   [!!] Node 版本过低：当前 v%NODE_MAJOR%，需要 20 或更高
  echo        下载地址：https://nodejs.org
  goto :end
)
echo   [OK] Node v%NODE_MAJOR% 已就绪

REM ---------- 2. 检查依赖 ----------
REM ⚠️ 必须逐个检查，不能只看 node_modules\astro：
REM    只要 astro 在、但 remark-directive 没装，就会「显示就绪、启动即报错」。
REM    所以要列出 package.json 里全部运行时依赖，缺哪个都触发安装。
set "NEED="
if not exist "node_modules\astro"                 set "NEED=1"
if not exist "node_modules\@astrojs\react"        set "NEED=1"
if not exist "node_modules\react"                 set "NEED=1"
if not exist "node_modules\react-dom"             set "NEED=1"
if not exist "node_modules\nanostores"            set "NEED=1"
if not exist "node_modules\@nanostores\react"     set "NEED=1"
if not exist "node_modules\remark-directive"      set "NEED=1"
if not exist "node_modules\unist-util-visit"      set "NEED=1"

if defined NEED (
  echo.
  echo   [..] 依赖不完整，正在安装（可能需要几分钟，请耐心等待）...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [!!] 安装失败。如果是网络问题，可以改用国内镜像重试：
    echo        npm install --registry=https://registry.npmmirror.com
    echo.
    echo        也可以不带参数重新运行本脚本，它会自动再装一次。
    goto :end
  )
)
REM 核对放在 if 块外面：块内的 set 要延迟展开才能读到，这里用 goto 绕开
if defined NEED goto :recheck

:ready
echo   [OK] 依赖已就绪

REM ---------- 3. 启动开发服务器 ----------
echo.
echo   ------------------------------------------
echo    启动中，稍后浏览器会自动打开：
echo    http://localhost:4321
echo.
echo    要停止测试：在这个窗口按 Ctrl + C
echo    如果 4321 打不开，看窗口里实际显示的地址
echo    （端口被占用时 Astro 会自动换一个）
echo   ------------------------------------------
echo.

REM 延时 6 秒再打开浏览器，给服务器一点启动时间
start /min "" cmd /c "timeout /t 6 /nobreak>nul & start http://localhost:4321"

call npm run dev
goto :end

:recheck
echo   [..] 安装完成，正在核对...
if not exist "node_modules\remark-directive" goto :stillmissing
if not exist "node_modules\unist-util-visit" goto :stillmissing
goto :ready

:stillmissing
echo.
echo   [!!] 装完仍然缺少 remark-directive / unist-util-visit
echo        请在项目目录里手动执行：
echo        npm install remark-directive unist-util-visit
goto :end

:install
echo.
echo   [..] 重新安装依赖...
call npm install
if errorlevel 1 ( echo   [!!] 安装失败 ) else ( echo   [OK] 安装完成 )
goto :end

::clean
:: ⚠️ 改了 src/plugins/*.mjs 这类 remark 插件后，Astro dev 会继续用
::    .astro 里的旧缓存渲染 markdown，页面看起来「改了没生效」。
:clean
echo.
echo   [..] 清理 Astro 缓存（改了插件后必须做这步）...
if exist ".astro" (
  rmdir /s /q ".astro"
  echo   [OK] 已删除 .astro
) else (
  echo   [..] 没有 .astro 目录，跳过
)
if exist "node_modules\.astro" (
  rmdir /s /q "node_modules\.astro"
  echo   [OK] 已删除 node_modules\.astro
)
if exist "dist" (
  rmdir /s /q "dist"
  echo   [OK] 已删除 dist
)
echo.
echo   [OK] 清理完成。现在请重新运行 start.bat（不带参数）启动。
goto :end

:build
echo.
echo   [..] 正在构建静态站点...
call npm run build
if errorlevel 1 (
  echo   [!!] 构建失败，请看上面的报错
) else (
  echo.
  echo   [OK] 构建完成，输出在 dist\ 目录
  echo        把这个目录的内容传上去就能部署到 GitHub Pages
)
goto :end

:nonode
echo   [!!] 没有检测到 Node.js
echo.
echo        请先安装 Node.js 20 或更高版本：https://nodejs.org
echo        安装时一路下一步即可，装完后重新双击本文件。
goto :end

:nonpm
echo   [!!] 检测到 Node.js，但没有 npm
echo.
echo        npm 通常随 Node.js 一起安装，建议重新运行安装包修复：
echo        https://nodejs.org
goto :end

:end
echo.
echo   按任意键关闭窗口...
pause >nul
exit /b 0
