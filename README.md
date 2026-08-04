# 경매 입찰·대출 자금 계산기 v1.4

## 포함 기능
- Google 로그인
- PC·핸드폰·다른 PC 동일 저장목록 자동동기화
- 저장 직전 Firestore 최신 revision 재확인
- 오래된 기기의 데이터가 최신자료를 덮어쓰지 못하도록 저장 중단
- 삭제 tombstone 유지로 다른 기기에서 삭제자료가 다시 살아나는 현상 방지
- 블록 순서 동기화 및 충돌 방지
- 최초 로그인 시 기존 브라우저 저장자료를 클라우드로 안전하게 이전
- 동일 ID가 클라우드에 이미 있으면 기존 클라우드 자료를 덮어쓰지 않음
- 백업 불러오기 시 동일 ID는 복사본으로 추가
- 최근 자동동기화 시각 표시

## GitHub Pages 등록 순서
1. 이 ZIP을 압축 해제합니다.
2. GitHub에서 새 Public 저장소를 만듭니다. 예: `auction-calculator`
3. 압축을 푼 파일 7개를 저장소 최상위에 모두 업로드합니다.
4. 저장소 `Settings` → `Pages`로 이동합니다.
5. Source는 `Deploy from a branch`, Branch는 `main`, Folder는 `/(root)`를 선택하고 저장합니다.
6. 몇 분 뒤 표시되는 GitHub Pages 주소를 확인합니다.
7. Firebase Console → Authentication → 설정 → 승인된 도메인으로 이동합니다.
8. GitHub Pages 도메인만 추가합니다. 예: `ayoung.github.io`
9. GitHub Pages 주소를 열고 Google 로그인합니다.
10. 핸드폰에서도 같은 주소를 열고 같은 Google 계정으로 로그인합니다.

## Firestore 규칙
Firebase Console → Firestore Database → 규칙에서 `firestore-rules.txt`의 내용을 그대로 게시합니다.

## 저장 충돌 방지 방식
- 저장자료마다 revision을 기록합니다.
- 저장 버튼을 누르면 Firestore transaction이 현재 서버 revision을 다시 읽습니다.
- 화면에 불러온 revision과 서버 revision이 다르면 저장을 취소합니다.
- 이때 서버의 최신자료를 다시 불러오므로 이전 기기의 오래된 자료가 최신자료를 덮어쓰지 않습니다.
- 삭제도 같은 revision 검사를 거치며 문서를 실제 제거하지 않고 deleted 상태로 남겨 재생성을 막습니다.

## 중요한 사용 규칙
- 저장·수정·삭제는 인터넷 연결 중에만 가능합니다.
- 계산과 저장자료 열람은 브라우저에 남은 캐시로 가능할 수 있지만, 충돌 방지를 위해 오프라인 저장은 차단됩니다.
- 어느 기기에서든 반드시 같은 Google 계정으로 로그인해야 같은 자료가 보입니다.
- Firebase API 설정값은 웹앱용 공개 설정값입니다. 서비스 계정 JSON 또는 Admin SDK 비공개 키는 GitHub에 올리면 안 됩니다.
