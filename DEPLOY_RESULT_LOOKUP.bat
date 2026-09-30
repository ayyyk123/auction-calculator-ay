@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo ==============================================
echo  경매계산기 매각결과 자동조회 서버 최초 배포

echo  프로젝트: auction-calculator-ay

echo ==============================================
echo.
where npm >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js/npm이 설치되어 있지 않습니다.
  echo Node.js LTS 설치 후 다시 실행해주세요.
  pause
  exit /b 1
)
where firebase >nul 2>nul
if errorlevel 1 (
  echo Firebase CLI를 설치합니다...
  call npm install -g firebase-tools
  if errorlevel 1 goto :fail
)
echo.
echo 1/4 Firebase 로그인 창을 엽니다.
call firebase login
if errorlevel 1 goto :fail

echo.
echo 2/4 함수 패키지를 설치합니다.
pushd functions
call npm install
if errorlevel 1 (popd & goto :fail)
popd

echo.
echo 3/4 Firebase 프로젝트를 선택합니다.
call firebase use auction-calculator-ay
if errorlevel 1 goto :fail

echo.
echo 4/4 courtAuctionResult 함수를 배포합니다.
call firebase deploy --only functions:courtAuctionResult
if errorlevel 1 goto :fail

echo.
echo ==============================================
echo  배포 완료

echo  이제 계산기의 '매각결과복기' 메뉴를 열면

echo  조회 가능한 물건을 순서대로 자동 확인합니다.

echo ==============================================
pause
exit /b 0

:fail
echo.
echo [배포 실패] 위 오류 메시지를 캡처해서 보내주세요.
pause
exit /b 1
