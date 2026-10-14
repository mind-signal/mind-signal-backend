import Consent from '../model/consent.schema';
import {
  consentRepository,
  PAPER_CONSENT_VERSION_ID,
} from './consent.repository';

jest.mock('../model/consent.schema', () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn(), findOne: jest.fn() },
}));

const findOneAndUpdate = Consent.findOneAndUpdate as unknown as jest.Mock;
const findOne = Consent.findOne as unknown as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('consentRepository.ensureConsent', () => {
  it('종이 동의서 기본값으로 upsert 호출함', async () => {
    findOneAndUpdate.mockResolvedValue({ _id: 'consent_1' });

    const doc = await consentRepository.ensureConsent('user_1');

    expect(doc).toEqual({ _id: 'consent_1' });
    const [filter, update, options] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ userId: 'user_1' });
    expect(update.$setOnInsert).toMatchObject({
      versionId: PAPER_CONSENT_VERSION_ID,
      isResearchAgreed: true,
    });
    expect(options).toMatchObject({ upsert: true, new: true });
  });

  it('$set이 아니라 $setOnInsert라 기존 웹 동의 문서를 덮어쓰지 않음', async () => {
    findOneAndUpdate.mockResolvedValue({ _id: 'consent_web', versionId: 'v1' });

    await consentRepository.ensureConsent('user_1');

    const update = findOneAndUpdate.mock.calls[0][1];
    expect(update.$set).toBeUndefined();
  });
});

describe('consentRepository.ensureConsent 동시 upsert 경쟁', () => {
  it('중복 키(11000)면 이긴 쪽이 만든 문서를 재조회해 반환함', async () => {
    findOneAndUpdate.mockRejectedValue(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
    );
    findOne.mockResolvedValue({ _id: 'consent_winner' });

    const doc = await consentRepository.ensureConsent('user_1');

    expect(doc).toEqual({ _id: 'consent_winner' });
    expect(findOne).toHaveBeenCalledWith({ userId: 'user_1' });
  });

  it('중복 키가 아닌 오류는 그대로 던짐', async () => {
    findOneAndUpdate.mockRejectedValue(
      Object.assign(new Error('연결 끊김'), { code: 89 })
    );

    await expect(consentRepository.ensureConsent('user_1')).rejects.toThrow(
      '연결 끊김'
    );
    expect(findOne).not.toHaveBeenCalled();
  });
});
