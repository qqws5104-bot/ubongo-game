# 2026-10-13 — 체키용 개선 1단계 (개선명세 P1 + P2)

엘리베이터(직선) 방향 싸움과 실물 우봉고는 그대로. 끝층 이점을 숫자로 없애고 대기를 줄였다. 2인 기준.

## 바뀐 것

| 항목 | 전 | 후 | 끄는 법 (`game-data.js`) |
|---|---|---|---|
| 배송 금액 | 종류별 고정 | 층 배율: B1·5F x0.7 / 1F·4F x1.0 / 2F·3F x1.3 | `FLOOR_REWARD_MULT` 전부 1.0 |
| 시작 층 | 1F 고정 | 하프마다 2F/3F 무작위 | `START_FLOOR_CHOICES = [1]` |
| 라운드 결과 | 둘 다 Space | 3초 후 자동 (둘 다 Space면 즉시) | `RESULT_AUTO_ADVANCE_MS = 0` |
| 후반 도둑 | 우선 지정 10초 → 도둑 5초 따로 | 우선 지정 창 안에서 같이, "확정"으로 진행 | `MERGE_PRIORITY_THIEF = 0` |
| 같은 층 여러 개 | 10초 선택 창 | 자동 (우선 지정 > 비싼 것 > 먼저 확보) ※팀 확정 필요 | `SAME_FLOOR_AUTO_PICK = 0` |

화면: 엘리베이터 층 옆 배율 배지(x1.3 / x0.7), 송장마다 금액, 레일 버튼에 금액 범위, 확정 층수 층 버튼에 그 층 금액,
결과 화면 "N초 뒤 자동으로", 메인 모니터에도 배율 배지와 결과 카운트다운.

## 변경 파일

- `game-data.js` — 새 상수 5개
- `game-room.js` — 규칙 묶음(`DEFAULT_RULES`/`LEGACY_RULES`), 송장 금액, 시작 층, 자동 진행, 합친 창, 같은 층 자동 선택
- `build_client.py` → `public/index.html` — 점수 복제본 동기화, 표시 추가. 퍼즐 원본 폴더가 없으면 기존 빌드의 퍼즐 이미지 재사용
- `mainview.css` — 배율 배지
- 테스트: `test_p1p2.js` 신규, 기존 테스트 7개 갱신, `regress.sh`에 추가
- 문서: `HANDOVER.md` 16절, `README.md`

## 배포

```bash
git add -A
git commit -m "체키용 개선 1단계: 층별 배송비, 시작층 무작위, 결과 자동 진행, 후반 우선지정+도둑 통합, 같은 층 자동 선택"
git push origin main   # Render 자동 배포
```

커밋 전 확인: `grep SECURE_PHASE_MS game-data.js` → `3 * 60 * 1000`, 네 종류 모두 `mini: null`(실물 우봉고).
