@echo off
rem TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
rem Builds bin\macshare-winhelper.exe with the .NET Framework C# compiler (C# 5 only).
rem AnyCPU: 64-bit on x64 PCs, native on Windows 11 on ARM (it has .NET Framework 4.8.1).
rem Works while TwinDesk is running: a running .exe can be renamed, so the new build is swapped
rem in and the app picks it up the next time it starts the helper.
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set BIN=%~dp0bin
if not exist "%BIN%" mkdir "%BIN%"
"%CSC%" /nologo /optimize+ /platform:anycpu /target:exe /out:"%BIN%\macshare-winhelper.new.exe" ^
  /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "%~dp0src\*.cs" || exit /b 1
rem The previous build may still be running (old.exe): then park the current one under another name.
del /q "%BIN%\macshare-winhelper.old*.exe" 2>nul
set OLD=macshare-winhelper.old.exe
if exist "%BIN%\%OLD%" set OLD=macshare-winhelper.old-%RANDOM%.exe
if exist "%BIN%\macshare-winhelper.exe" ren "%BIN%\macshare-winhelper.exe" %OLD%
ren "%BIN%\macshare-winhelper.new.exe" macshare-winhelper.exe
