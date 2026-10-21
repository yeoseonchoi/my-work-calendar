// .env 파일을 가장 먼저 읽어 환경변수로 등록 (다른 모듈보다 먼저 import 해야 함)
try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch {
  // .env 가 없으면 기본값 사용
}
