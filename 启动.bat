@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PDX Map Editor

set PYCMD=
rem where 找得到的可能只是 Microsoft Store 的占位 stub（装了"假装有 python"），
rem 所以找到候选还得**真跑一句**验证，不然会出现"启动了但什么都没发生"。
where python >nul 2>nul && (python -c "print(1)" >nul 2>nul && set PYCMD=python)
if "%PYCMD%"=="" (where py >nul 2>nul && (py -c "print(1)" >nul 2>nul && set PYCMD=py))

if "%PYCMD%"=="" (
  echo.
  echo   Python 3 not found.
  echo   Get it from https://www.python.org/downloads/
  echo   and tick "Add python.exe to PATH" while installing.
  echo.
  pause
  exit /b 1
)

%PYCMD% -c "import PIL" >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Pillow missing, installing...
  echo.
  %PYCMD% -m pip install pillow
)

%PYCMD% server.py
pause
