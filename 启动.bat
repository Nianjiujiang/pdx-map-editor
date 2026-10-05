@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PDX Map Editor

set PYCMD=
where python >nul 2>nul && set PYCMD=python
if "%PYCMD%"=="" (where py >nul 2>nul && set PYCMD=py)

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
