# 트러블슈팅

## Redis 연결 안 될 때
```bash
# 도커 상태 확인
docker ps

# Redis 컨테이너만 다시 시작
npm run infra:down
npm run infra:up
```

## Python 엔진 실행 안 될 때
```bash
# conda 환경 확인
conda activate mind-signal
pip install -r requirements.txt

# Emotiv App이 로컬에서 실행 중인지 확인 (헤드셋 연결 필수)
```

## 포트 충돌 시
```bash
# 5000번 포트 사용 중인 프로세스 확인 (Windows)
netstat -ano | findstr :5000
taskkill /PID <PID번호> /F
```
