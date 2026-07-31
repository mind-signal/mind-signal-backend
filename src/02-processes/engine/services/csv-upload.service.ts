import fs from 'fs';
import path from 'path';
import { config } from '@07-shared/config/config';
import { AppError } from '@07-shared/errors';

// 업로드 파일명 화이트리스트 — path traversal 차단 + analysis.py find_csv_files 패턴 정합
const FILENAME_RE = /^subject_[12]_[A-Za-z0-9]+_\d{8}_\d{6}\.csv$/;

/**
 * 업로드 CSV 저장 디렉토리 반환함.
 * 기본값은 BE 루트의 형제 csv 폴더(Team-project/csv) — DE 분석(find_csv_files)이 읽는 위치.
 * 테스트는 CSV_STORAGE_DIR 환경변수로 override함.
 *
 * @returns CSV 저장 디렉토리 절대경로
 */
export function resolveCsvDir(): string {
  return (
    process.env.CSV_STORAGE_DIR || path.resolve(process.cwd(), '..', 'csv')
  );
}

/**
 * 노트북 B DE가 업로드한 subject CSV를 operator csv 폴더에 저장함 (2-PC 집계).
 * 원본은 각 노트북에 분산 유지하고 분석용 사본만 operator로 모으는 모델임.
 *
 * @param params - secretKey 검증값, filename(화이트리스트), content(CSV 본문)
 * @returns 저장된 파일 절대경로
 * @throws AppError 403 — secretKey 불일치
 * @throws AppError 400 — filename 패턴 위반
 */
export function saveUploadedCsv(params: {
  secretKey: string;
  filename: string;
  content: string;
}): string {
  if (params.secretKey !== config.dataEngine.secretKey) {
    throw new AppError('유효하지 않은 시크릿 키입니다.', 403);
  }
  if (!FILENAME_RE.test(params.filename)) {
    throw new AppError('유효하지 않은 파일명입니다.', 400);
  }
  const dir = resolveCsvDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, params.filename);
  // 멱등 — 같은 파일 재업로드 시 overwrite함
  fs.writeFileSync(dest, params.content ?? '', 'utf-8');
  return dest;
}
