# v1.23.0 매각결과 자동조회 Firebase Function 배포

이 버전의 정적 `index.html`은 아래 HTTPS Function을 호출합니다.

- 프로젝트: `auction-calculator-ay`
- 리전: `asia-northeast3`
- 함수명: `courtAuctionResult`
- 기본 URL: `https://asia-northeast3-auction-calculator-ay.cloudfunctions.net/courtAuctionResult`

## 최초 1회 배포

Firebase CLI가 없다면 설치합니다.

```bash
npm install -g firebase-tools
```

프로젝트 루트(이 파일과 `firebase.json`이 있는 폴더)에서:

```bash
firebase login
cd functions
npm install
cd ..
firebase use auction-calculator-ay
firebase deploy --only functions:courtAuctionResult
```

배포가 끝나면 계산기의 `매각결과복기` 메뉴에서 자동조회가 동작합니다.

## 안전장치

- Firebase 로그인 사용자의 ID 토큰이 있어야 함수가 응답합니다.
- 계산기 상태가 `미입찰기록` 또는 `입찰 O`인 물건만 프런트에서 조회합니다.
- 이미 `입찰결과` 탭에 직접 결과값(`auctionResult.status`)이 있는 물건은 조회 대상에서 제외하며, 저장 트랜잭션에서도 한 번 더 차단합니다.
- 자동조회 데이터는 `state.courtAuctionResult`에 별도로 저장됩니다. 직접 입력한 `state.auctionResult`를 덮어쓰지 않습니다.
- 법원경매정보 요청은 직렬 처리하고 간격을 두며, BLOCKED 신호를 받으면 재시도하지 않습니다.

## 참고

법원경매정보는 공식 Open API가 아니라 공개 웹사이트의 내부 조회 통신을 사용하는 방식입니다. 사이트 구조가 바뀌면 함수 쪽 보정이 필요할 수 있습니다. 실제 입찰 판단 전에는 법원 원문을 다시 확인하세요.
