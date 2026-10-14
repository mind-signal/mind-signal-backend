const mockSend = jest.fn();
const mockConverseCommand = jest.fn().mockImplementation((input) => input);

jest.mock('@07-shared/config/config', () => ({
  config: {
    bedrock: {
      region: 'ap-northeast-2',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      modelId: 'test-inference-profile',
    },
  },
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  ConverseCommand: mockConverseCommand,
}));

jest.mock('@06-entities/analysis-results', () => ({
  AnalysisResult: { findOne: jest.fn() },
}));

jest.mock('@05-features/sessions', () => ({
  assertGroupOwnership: jest.fn(),
}));

import { chatService } from './chat.service';
import { AnalysisResult } from '@06-entities/analysis-results';
import { assertGroupOwnership } from '@05-features/sessions';
import { AppError } from '@07-shared/errors';

describe('chatService.callLLM — Amazon Bedrock 연동 검증함', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('Bedrock Converse 응답의 페이지 키워드를 URL 안내 응답으로 변환함', async () => {
    mockSend.mockResolvedValue({
      output: { message: { content: [{ text: 'Keyword: 소개' }] } },
    });

    const result = await chatService.callLLM('프로젝트 소개를 보고 싶어요');

    expect(mockConverseCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'test-inference-profile',
        messages: [
          {
            role: 'user',
            content: [{ text: '프로젝트 소개를 보고 싶어요' }],
          },
        ],
      })
    );
    expect(result).toEqual({
      status: 'success',
      message: '관련 페이지를 안내해 드립니다.',
      url: 'https://mind-signal-frontend.vercel.app/intro',
      level: 1,
    });
  });

  it('Bedrock 오류 시 문의 유도용 기본 응답을 반환함', async () => {
    mockSend.mockRejectedValue(new Error('Access denied'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation();

    const result = await chatService.callLLM('도움말');

    expect(result).toEqual({
      status: 'success',
      message: '죄송합니다. 요청하신 질문에 대해 답변을 찾지 못했습니다.',
      url: '',
      level: 3,
    });
    consoleError.mockRestore();
  });

  it('알 수 없는 Keyword 제어 표식을 사용자 응답으로 노출하지 않음', async () => {
    mockSend.mockResolvedValue({
      output: { message: { content: [{ text: 'Keyword: 없는페이지' }] } },
    });

    const result = await chatService.callLLM('없는 페이지로 이동해 주세요');

    expect(result).toEqual({
      status: 'success',
      message: '죄송합니다. 요청하신 질문에 대해 답변을 찾지 못했습니다.',
      url: '',
      level: 3,
    });
  });
});

describe('chatService.processMessage — 분석 리포트 소유권 (AUTH-W003)', () => {
  const GROUP_ID = '65c9f0b2a1b2c3d4e5f67890';
  const USER_ID = 'operator-1';
  // search-pre-list 키워드가 없는 문장이어야 조회 단계까지 감
  const MESSAGE = '내 리포트 요약해 줘';
  const LLM_RESULT = {
    status: 'success' as const,
    message: 'ok',
    url: '',
    level: 2 as const,
  };
  let callLLM: jest.SpyInstance;

  /** findOne(...).select().lean().exec() 체인 mock 생성함 */
  const mockFindOneReturning = (doc: { markdown: string } | null) => {
    (AnalysisResult.findOne as jest.Mock).mockReturnValue({
      select: () => ({ lean: () => ({ exec: async () => doc }) }),
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(assertGroupOwnership).mockReset().mockResolvedValue(undefined);
    mockFindOneReturning({ markdown: 'REPORT' });
    callLLM = jest.spyOn(chatService, 'callLLM').mockResolvedValue(LLM_RESULT);
  });

  afterEach(() => {
    callLLM.mockRestore();
  });

  it('C1 — 그룹을 만든 운영자도 groupId 로 리포트를 받음', async () => {
    await chatService.processMessage(MESSAGE, USER_ID, GROUP_ID);

    expect(assertGroupOwnership).toHaveBeenCalledWith(GROUP_ID, USER_ID);
    expect(AnalysisResult.findOne).toHaveBeenCalledWith({ groupId: GROUP_ID });
    expect(callLLM).toHaveBeenCalledWith(MESSAGE, 'REPORT');
  });

  it('C2 — 그룹과 무관한 사용자는 리포트 없이 답을 받음', async () => {
    jest
      .mocked(assertGroupOwnership)
      .mockRejectedValueOnce(new AppError('권한 없음', 403));

    await chatService.processMessage(MESSAGE, USER_ID, GROUP_ID);

    expect(AnalysisResult.findOne).not.toHaveBeenCalled();
    expect(callLLM).toHaveBeenCalledWith(MESSAGE, undefined);
  });

  it('C3 — 세션이 없는 그룹이면 리포트 없이 답을 받음', async () => {
    jest
      .mocked(assertGroupOwnership)
      .mockRejectedValueOnce(new AppError('그룹 없음', 404));

    await chatService.processMessage(MESSAGE, USER_ID, GROUP_ID);

    expect(AnalysisResult.findOne).not.toHaveBeenCalled();
    expect(callLLM).toHaveBeenCalledWith(MESSAGE, undefined);
  });

  it('C4 — 소유권 확인 중 DB 오류는 삼키지 않고 전파함', async () => {
    jest
      .mocked(assertGroupOwnership)
      .mockRejectedValueOnce(new Error('db down'));

    await expect(
      chatService.processMessage(MESSAGE, USER_ID, GROUP_ID)
    ).rejects.toThrow('db down');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('C5 — 로그인하지 않으면 소유권도 리포트도 조회하지 않음', async () => {
    await chatService.processMessage(MESSAGE, undefined, GROUP_ID);

    expect(assertGroupOwnership).not.toHaveBeenCalled();
    expect(AnalysisResult.findOne).not.toHaveBeenCalled();
  });
});
