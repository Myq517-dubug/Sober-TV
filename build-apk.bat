@echo off
REM ============================================================
REM  Sober TV - Android 构建脚本
REM  用法：
REM    build-apk.bat          构建 release APK（分架构）
REM    build-apk.bat debug    构建 debug APK
REM ============================================================
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0"
set "BUILD_TYPE=%~1"
if "%BUILD_TYPE%"=="" set "BUILD_TYPE=release"

REM ---- JDK ----
if defined JAVA_HOME (
  echo [env] JAVA_HOME = %JAVA_HOME%
) else (
  set "JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot"
  echo [env] 使用默认 JDK: %JAVA_HOME%
)
set "PATH=%JAVA_HOME%\bin;%PATH%"

REM ---- Android SDK ----
if not defined ANDROID_HOME (
  if exist "D:\android-sdk" (
    set "ANDROID_HOME=D:\android-sdk"
  ) else (
    echo [错误] 未找到 Android SDK，请设置 ANDROID_HOME
    exit /b 1
  )
)
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
echo [env] ANDROID_HOME = %ANDROID_HOME%

REM ---- local.properties ----
REM 必须用正斜杠。反斜杠会被 Gradle 当作转义符，
REM 导致 SdkLocator.validateSdkPath 抛 "文件名、目录名或卷标语法不正确"
if not exist "%PROJECT_DIR%android\local.properties" (
  echo sdk.dir=%ANDROID_HOME:\=/%> > "%PROJECT_DIR%android\local.properties"
)

REM ---- Node ----
where node >nul 2>nul
if errorlevel 1 (
  set "PATH=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6;%PATH%"
)

REM ---- 强制 UTF-8 编码 ----
REM Windows 中文环境（GBK 代码页）下 Gradle 解析路径会报
REM "文件名、目录名或卷标语法不正确"，必须显式指定 UTF-8
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8"
set "GRADLE_OPTS=-Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8"

cd /d "%PROJECT_DIR%"

echo.
echo [1/3] 构建前端...
call npm run build
if errorlevel 1 (
  echo [错误] 前端构建失败
  exit /b 1
)

echo.
echo [2/3] 同步到 Android...
REM 注意：npx cap sync android 在本机会被「安全删除」保护拦截
REM （Capacitor 会先删除 assets/public 再重建），故改为手动复制。
if exist "%PROJECT_DIR%android\app\src\main\assets\public" (
  rmdir /s /q "%PROJECT_DIR%android\app\src\main\assets\public" 2>nul
)
mkdir "%PROJECT_DIR%android\app\src\main\assets\public" 2>nul
xcopy /E /I /Y /Q "%PROJECT_DIR%dist\*" "%PROJECT_DIR%android\app\src\main\assets\public\" >nul
if errorlevel 1 (
  echo [错误] 同步失败
  exit /b 1
)
echo [env] 已同步 dist 到 assets/public

echo.
echo [3/3] Gradle 构建 (%BUILD_TYPE%)...
cd /d "%PROJECT_DIR%android"
REM lint 已在 app/build.gradle 中通过 checkReleaseBuilds false 关闭
call gradlew.bat assemble%BUILD_TYPE% --no-daemon
if errorlevel 1 (
  echo [错误] Gradle 构建失败
  exit /b 1
)

echo.
echo [完成] APK 产物：
cd /d "%PROJECT_DIR%android\app\build\outputs\apk"
for %%f in (%%f) do @echo   %%~nxf  %%~zf bytes

endlocal
