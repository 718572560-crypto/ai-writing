@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.5 或更新版本，然后重新运行。
  pause
  exit /b 1
)
echo 有术 Studio 即将启动。
echo 请在浏览器打开 http://127.0.0.1:4175
echo 关闭本窗口可停止服务。
if not exist "node_modules\playwright-core\package.json" (
  call npm install --omit=dev
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)
node scripts\supervise.cjs
pause
