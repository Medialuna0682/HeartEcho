@echo off
chcp 936 >nul 2>nul
setlocal
cd /d "%~dp0"

rem 优先用打包好的单文件 exe：自带 Node，双击即用，而且没有命令行窗口
if exist "%~dp0dist\心语.exe" (
  start "" "%~dp0dist\心语.exe"
  exit /b 0
)

rem 没有 exe 才退回源码模式（开发用，会保留这个窗口方便看输出）
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 既没有 dist\心语.exe，也没有安装 Node.js 22 或更高版本。
  echo   安装地址：https://nodejs.org
  echo.
  pause
  exit /b 1
)

title 心语 · 源码模式
echo 正在以源码模式启动心语…（关掉这个窗口 = 停止运行）
:loop
node index.mjs --tray --open-panel
set CODE=%errorlevel%
if "%CODE%"=="0" goto end
if "%CODE%"=="42" (
  timeout /t 2 /nobreak >nul
  goto loop
)
echo.
echo   [提示] 程序异常退出了（代码 %CODE%），5 秒后自动重启。
timeout /t 5 /nobreak >nul
goto loop
:end
pause
