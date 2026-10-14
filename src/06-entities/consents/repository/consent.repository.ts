import { Types } from 'mongoose';
import Consent, { ConsentDoc } from '../model/consent.schema';

/**
 * 종이 동의서 버전 식별자.
 *
 * 연구 동의서와 심리 설문을 종이로 받기로 하면서(2026-09-02) 웹 동의 화면을
 * 거치지 않게 됐다. 그러면 Consent 문서가 안 생겨 EegRecord.consentId가
 * 영구히 빈다. 측정 당일 종이 동의서를 미리 받아두므로, DB에는 그 사실을
 * 가리키는 문서를 자동으로 남긴다. 정본은 종이 원본이고 이 문서는 참조용이다.
 *
 * ConsentVersion 컬렉션에 같은 versionId 문서가 없어도 동작한다 —
 * Consent.versionId는 ObjectId 참조가 아니라 문자열이다.
 */
export const PAPER_CONSENT_VERSION_ID = 'PAPER-v1';

/**
 * 해당 유저의 Consent를 조회하고, 없으면 종이 동의서 기록으로 자동 생성한다.
 *
 * 웹 동의 화면(submitConsentProcess)을 거친 유저는 그 문서가 그대로 반환되고
 * 종이로 받은 유저만 새로 생긴다. upsert라 재시도로 중복이 쌓이지 않는다.
 */
async function ensureConsent(
  userId: Types.ObjectId | string
): Promise<ConsentDoc> {
  try {
    return (await Consent.findOneAndUpdate(
      { userId },
      {
        $setOnInsert: {
          userId,
          versionId: PAPER_CONSENT_VERSION_ID,
          isResearchAgreed: true,
          withdrawnAt: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )) as ConsentDoc;
  } catch (err) {
    // upsert 경쟁에서 진 쪽이 받는 중복 키 오류임. userId unique 인덱스가
    // 문서를 하나로 지켜 줬다는 뜻이므로 이긴 쪽이 만든 문서를 돌려줌
    if ((err as { code?: number })?.code !== 11000) throw err;
    return (await Consent.findOne({ userId })) as ConsentDoc;
  }
}

export const consentRepository = { ensureConsent };
export default consentRepository;
