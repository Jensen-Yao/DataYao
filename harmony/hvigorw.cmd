@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%node_modules\@ohos\hvigor\bin\hvigor.js" %*
exit /b %ERRORLEVEL%
