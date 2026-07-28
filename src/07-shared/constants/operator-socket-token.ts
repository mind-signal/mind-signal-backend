export const OPERATOR_SOCKET_TOKEN_TYPE = 'operator_socket';

/**
 * 표준 10분 측정 전후의 합류 지연과 일시 단절 후 재접속 여유를
 * 포함하되 장시간 권한 노출을 제한하기 위한 30분 유효기간 설정함.
 */
export const OPERATOR_SOCKET_TOKEN_TTL_SECONDS = 30 * 60;
