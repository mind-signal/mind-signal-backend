# Architecture Rules — Mind Signal Backend (Express + TypeScript + FSD)

## Directory layout

```
src/
├── 07-shared/       # infra — Redis, Socket.io, config, errors, common types
│   ├── config/      # env parsing (config.ts is the single source of truth)
│   ├── errors/      # AppError class
│   ├── lib/         # redis, socket, testing utilities
│   ├── middlewares/ # authenticate, validate
│   └── types/       # shared TS types (AuthedRequest etc.)
├── 06-entities/     # DB schemas & CRUD — Session, User, EegRecord, AnalysisResult...
├── 05-features/     # single-domain — auth, users, surveys, sessions (QR create/read only)
├── 02-processes/    # orchestration — measurements (EEG streaming), engine (analysis proxy)
└── 01-app/          # entrypoint, global router, middleware registration

scripts/             # outside FSD — one-off meta tools (DB seeding etc.), excluded from
                      # depcruise. Importing from `src/` is forbidden — see scripts/README.md.
```

### Where to put a controller

- **02-processes**: multiple entities + Redis + an external engine need to be coordinated (e.g. `startMeasurement`, AI analysis orchestration).
- **05-features**: single domain, plain CRUD (Auth, Users, Surveys, Sessions QR create/read).

## Import direction

```
01-app → 02-processes → 05-features → 06-entities → 07-shared
```

A lower layer number may import from a higher one; never the reverse. `07-shared` imports no other layer. No direct cross-slice import within `05-features` — go through the target slice's `index.ts`.

| From ↓ \ To → | 07-shared | 06-entities | 05-features | 02-processes | 01-app |
|----------------|-----------|-------------|-------------|--------------|--------|
| 07-shared      | ✓ (intra) | ✗           | ✗           | ✗            | ✗      |
| 06-entities    | ✓         | ✓ (intra)   | ✗           | ✗            | ✗      |
| 05-features    | ✓         | ✓           | ✓ (intra)   | ✗            | ✗      |
| 02-processes   | ✓         | ✓           | ✓           | ✓ (intra)    | ✗      |
| 01-app         | ✓         | ✓           | ✓           | ✓            | ✓      |

Intra = same slice, relative imports allowed.

## Path alias

Layer-crossing imports must use the alias, never a relative path:

```typescript
import { config } from '@07-shared/config/config';
import { AppError } from '@07-shared/errors';
import { Session } from '@06-entities/sessions';
import { engineRegistryService } from '@02-processes/engine/services/engine-registry.service';

// ❌ import { AppError } from '../../../07-shared/errors';
// ❌ import dotenv from 'dotenv';  — go through config.ts instead
```

Full alias examples per layer: `.agents/rules/shared-utils.md`.

## `npm run depcruise` — what it actually enforces

`.dependency-cruiser.cjs` sets the FSD-boundary rules to `warn` unless `DEPCRUISE_BLOCKING=true` is set — advisory until that flag flips. Every other rule (no-circular, no-orphans, etc.) is `error` unconditionally. CI runs depcruise with `continue-on-error: true`, so a boundary violation is reported but does not block the merge today. Treat a depcruise warning as a required fix regardless — the advisory setting is a migration grace period, not a license to leave it.

## [ADR-004] Engine URL abstraction — 2PC boundary

Engine access goes through `DATA_ENGINE_URL` (env, with fallback) + `engineRegistryService` over HTTP/WS.

```typescript
import { engineRegistryService } from '@02-processes/engine/services/engine-registry.service';
const engineUrl = engineRegistryService.getActiveUrl();

import { config } from '@07-shared/config/config';
const baseUrl = config.dataEngine.baseUrl; // falls back to http://localhost:5002
```

`child_process.spawn` is never called directly in service code. It is encapsulated inside `measurementService` only (`src/02-processes/measurements/services/measurement.service.ts`, reached via `engineProxyService`). This isolation exists so a 2PC setup can substitute a remote-PC engine without touching any call site.

## Session state machine

```
CREATED → PAIRED → MEASURING → COMPLETED
   ↓          ↓         ↓
EXPIRED   CANCELLED  CANCELLED
```

Pairing timeout 5 min (CREATED → EXPIRED), standard measurement 10 min, 10s of silence → CANCELLED.

## Redis channel key

```
mind-signal:{groupId}:subject:{subjectIndex}
```

`groupId` = MongoDB ObjectId string, `subjectIndex` = 1-based (matches the `[1, 2]` loop in `measurement.service.ts`). No PC/host info in the key — it breaks multi-PC consistency. No fixed/global channel name (`mind-signal-live` style) — it was removed and must not come back.

## Timestamp source of truth

Server-side ingest timestamp (when the backend receives the Redis message) is the single source of truth. Client-local clocks (browser/headset SDK) are only for intra-batch ordering. NTP sync / LSL absolute timestamps are out of scope for now.

## Security

- **JWT**: stored in frontend `localStorage`. XSS input validation is the primary defense. Switching to httpOnly cookies needs a new ADR (cross-domain Vercel↔Heroku complexity is the reason it hasn't happened).
- **XSS**: Next.js JSX auto-escaping blocks most frontend XSS, but the backend is the real defense point — all user input goes through Zod validation before it's stored; never persist a raw string unvalidated.

## Cross-reference

- Import alias table, `AppError`, Zod middleware, Socket usage: `.agents/rules/shared-utils.md`
- File/folder naming, Korean comment rule: `.agents/rules/code-style.md`
- Test conventions (including the external-repo `it.skip` pattern): `.agents/rules/test-modification.md`
- Troubleshooting: `.agents/rules/troubleshooting.md`
