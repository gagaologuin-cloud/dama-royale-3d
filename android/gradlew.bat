@rem Gradle startup script for Windows
@if "%%DEBUG%%"=="" @echo off
@setlocal
set DIRNAME=%%~dp0
if "%%~dp0%"=="" set DIRNAME=.
set APP_BASE_NAME=%%~n0
set APP_HOME=%%~dp0%
set JAVA_EXE=java.exe
if defined JAVA_HOME set JAVA_EXE=%C:\Program Files\Eclipse Adoptium\jdk-17.0.21.9-hotspot\%\bin\java.exe
"%C:\Program Files\Eclipse Adoptium\jdk-17.0.21.9-hotspot\\bin\java.exe%" -Xmx64m -Xms64m -jar "%%~dp0%\gradle\wrapper\gradle-wrapper.jar" %%*
@endlocal
