import { exec } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { RequestHandler, Request } from 'express';
import { config } from '@07-shared/config/config';
import { redisService } from '@07-shared/lib/redis';
import { engineRegistryService } from '@02-processes/engine/services/engine-registry.service';
import { dualTriggerService } from '@02-processes/engine/services/dual-2pc-trigger.service';
import {
  getActiveDualGroup,
  resetActiveDualGroup,
} from '@02-processes/measurements/services/measurement.service';

const execAsync = promisify(exec);

const DE_A_URL = config.dataEngine.baseUrl;
const DE_B_URL = process.env.NOTEBOOK_B_URL ?? '';
const SECRET = config.dataEngine.secretKey;

// 진단/수정 API는 localhost(loopback)에서만 허용함 — 원격 노출 차단 (dev 전용 도구)
function isLoopback(req: Request): boolean {
  // 빈 IP는 fail-open 방지를 위해 허용하지 않음 (명시적 loopback 주소만 통과)
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// CSRF 방어 — 전역 cors() 하에서 악성 사이트가 브라우저로 localhost 액션을 호출하는 것 차단함.
// Origin 헤더가 있으면 대시보드 동일 출처만 허용, 없으면(same-origin GET/curl) loopback 게이트로 충분함.
const ALLOWED_ORIGINS = ['http://localhost:5000', 'http://127.0.0.1:5000'];
function isSameOrigin(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

// 진단 API 접근 가드 — loopback + 동일 출처 둘 다 통과해야 함
function denyUnsafe(req: Request): boolean {
  return !isLoopback(req) || !isSameOrigin(req);
}

interface DeHealth {
  reachable: boolean;
  registeredGroupId: string | null;
  streaming: boolean | null;
  subjectIndex: number | null;
}

// DE /health 조회해 registered_group_id + streaming 노출 형태로 정규화함
async function fetchDeHealth(url: string): Promise<DeHealth> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return {
        reachable: false,
        registeredGroupId: null,
        streaming: null,
        subjectIndex: null,
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      reachable: true,
      registeredGroupId: (body.registered_group_id as string) ?? null,
      streaming: (body.streaming as boolean) ?? null,
      subjectIndex: (body.subject_index as number) ?? null,
    };
  } catch {
    return {
      reachable: false,
      registeredGroupId: null,
      streaming: null,
      subjectIndex: null,
    };
  }
}

// DE /logs 조회함 (secret 헤더 첨부)
async function fetchDeLogs(url: string, tail: number): Promise<unknown> {
  const res = await fetch(`${url}/logs?tail=${tail}`, {
    headers: { 'X-Engine-Secret': SECRET },
    signal: AbortSignal.timeout(3000),
  });
  return res.json();
}

// DE /control/release 호출함 (비상 해제)
async function releaseDe(url: string): Promise<unknown> {
  try {
    const res = await fetch(`${url}/control/release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Secret': SECRET,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(4000),
    });
    return { url, ok: res.ok, body: await res.json() };
  } catch (e) {
    return { url, ok: false, error: (e as Error).message };
  }
}

/**
 * 집계 진단 스냅샷 반환함 — groupId 일치확인 + pending + 그룹 목록 (대시보드 진단 패널용).
 */
export const diagStatus: RequestHandler = async (req, res) => {
  if (denyUnsafe(req)) {
    return res
      .status(403)
      .json({ status: 'fail', message: 'loopback + same-origin only' });
  }

  const [deA, deB] = await Promise.all([
    fetchDeHealth(DE_A_URL),
    DE_B_URL ? fetchDeHealth(DE_B_URL) : Promise.resolve(null),
  ]);

  const beActive = getActiveDualGroup();
  const pendingSubjects = engineRegistryService.getPendingSubjects();
  const registeredGroups = engineRegistryService.getRegisteredGroups();

  // groupId 일치 판정 — 해당 참가자(deA, deB(URL 설정 시), BE active)가
  // 모두 non-null 이고 같은 groupId 일 때만 matched. 누락 참가자는 미일치로 처리(fail-open 방지).
  const applicable = [
    deA.registeredGroupId,
    ...(DE_B_URL ? [deB?.registeredGroupId ?? null] : []),
    beActive,
  ];
  const nonNull = applicable.filter((g): g is string => Boolean(g));
  const distinct = [...new Set(nonNull)];
  const allIdle = nonNull.length === 0;
  const matched =
    !allIdle && nonNull.length === applicable.length && distinct.length === 1;
  const state = allIdle ? 'idle' : matched ? 'matched' : 'mismatch';

  return res.status(200).json({
    status: 'success',
    data: {
      beActiveGroup: beActive,
      dataEngineA: deA,
      dataEngineB: deB,
      pendingSubjects,
      registeredGroups,
      registryEvents: engineRegistryService.getRegistryEvents(),
      match: {
        matched,
        state,
        distinct,
        deA: deA.registeredGroupId,
        deB: deB?.registeredGroupId ?? null,
        beActive,
      },
    },
  });
};

// ── 액션 핸들러들 (화이트리스트) ──

async function actionReleaseAll(): Promise<unknown> {
  const deResults = await Promise.all([
    releaseDe(DE_A_URL),
    ...(DE_B_URL ? [releaseDe(DE_B_URL)] : []),
  ]);
  const cleared = engineRegistryService.clearAll();
  // BE 활성 그룹도 초기화 — release-all 후 stale activeDualGroup 방지
  resetActiveDualGroup();
  return { deResults, cleared };
}

async function actionRegistryStatus(groupId: string): Promise<unknown> {
  if (!groupId) {
    return { error: 'groupId query required' };
  }
  const status = dualTriggerService.getRegistryStatus(groupId);
  const group = engineRegistryService.getByGroup(groupId);
  return {
    groupId,
    status,
    registeredSubjects: group ? [...group.keys()].sort() : [],
  };
}

// redis 에 실제 EEG 메시지가 흐르는지 ~2초 psubscribe 샘플링함
async function actionRedisSample(): Promise<unknown> {
  const sub = redisService.client.duplicate();
  await sub.connect();
  const messages: Array<{ channel: string; preview: string }> = [];
  try {
    await sub.pSubscribe('mind-signal:*', (msg: string, channel: string) => {
      if (messages.length < 20) {
        messages.push({ channel, preview: msg.slice(0, 160) });
      }
    });
    await new Promise((r) => setTimeout(r, 2000));
    await sub.pUnsubscribe('mind-signal:*');
  } finally {
    await sub.quit();
  }
  return { sampled: messages.length, messages };
}

// 방화벽 인바운드 허용 규칙 추가함 (Tailscale 대역 한정) — 관리자 권한 없으면 실패 보고
async function actionFirewallAllow(): Promise<unknown> {
  const ps =
    "New-NetFirewallRule -DisplayName 'MindSignal-5050-in' -Direction Inbound " +
    '-LocalPort 5050 -Protocol TCP -Action Allow -RemoteAddress 100.64.0.0/10 ' +
    '-ErrorAction Stop; ' +
    "New-NetFirewallRule -DisplayName 'MindSignal-5002-in' -Direction Inbound " +
    '-LocalPort 5002 -Protocol TCP -Action Allow -RemoteAddress 100.64.0.0/10 ' +
    '-ErrorAction Stop; Write-Output OK';
  try {
    const { stdout, stderr } = await execAsync(
      `powershell -NoProfile -Command "${ps}"`,
      { timeout: 15000 }
    );
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    // 관리자 권한 필요 시 여기서 실패 — 대시보드에 원인 표기함
    return { ok: false, error: (e as Error).message };
  }
}

// operator DE_A 종료 후 런처로 재기동함 (idle-rebind로 대부분 불필요하나 수동 복구용)
async function actionRestartDeA(): Promise<unknown> {
  const launcher = path.join(
    process.cwd(),
    '..',
    'mind-signal-data-engine',
    'scripts',
    'realdevice',
    'start-realdevice-dual-2pc.ps1'
  );
  const kill =
    'Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\'\\" | ' +
    "Where-Object { $_.CommandLine -like '*run_server.py*' } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ' +
    'Start-Sleep -Seconds 2';
  try {
    await execAsync(`powershell -NoProfile -Command "${kill}"`, {
      timeout: 15000,
    });
    const { stdout } = await execAsync(
      `powershell -NoProfile -File "${launcher}"`,
      { timeout: 90000 }
    );
    return { ok: true, tail: stdout.split('\n').slice(-8).join('\n') };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 진단/수정 액션 실행함 — 고정 화이트리스트, localhost 전용.
 */
export const diagAction: RequestHandler = async (req, res) => {
  if (denyUnsafe(req)) {
    return res
      .status(403)
      .json({ status: 'fail', message: 'loopback + same-origin only' });
  }
  const name = req.params.name;
  const tail = Math.min(Number(req.query.tail) || 200, 1000);
  const groupId = (req.query.groupId as string) ?? '';

  try {
    let result: unknown;
    switch (name) {
      case 'release-all':
        result = await actionReleaseAll();
        break;
      case 'registry-status':
        result = await actionRegistryStatus(groupId);
        break;
      case 'redis-sample':
        result = await actionRedisSample();
        break;
      case 'notebook-b-logs':
        result = DE_B_URL
          ? await fetchDeLogs(DE_B_URL, tail)
          : { error: 'NOTEBOOK_B_URL 미설정' };
        break;
      case 'de-a-logs':
        result = await fetchDeLogs(DE_A_URL, tail);
        break;
      case 'firewall-allow':
        result = await actionFirewallAllow();
        break;
      case 'restart-de-a':
        result = await actionRestartDeA();
        break;
      default:
        return res
          .status(404)
          .json({ status: 'fail', message: `unknown action: ${name}` });
    }
    return res
      .status(200)
      .json({ status: 'success', action: name, data: result });
  } catch (e) {
    return res
      .status(500)
      .json({ status: 'error', action: name, message: (e as Error).message });
  }
};
