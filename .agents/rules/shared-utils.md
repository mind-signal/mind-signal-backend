# Shared Utility Usage — Mind Signal Backend

## Import alias table

```typescript
import { config } from '@07-shared/config/config';
import { AppError } from '@07-shared/errors';
import { redisService } from '@07-shared/lib/redis';
import { SocketService } from '@07-shared/lib/socket';
import { authenticate } from '@07-shared/middlewares/authenticate.middleware';
import { validate } from '@07-shared/middlewares/validate.middleware';
import type { AuthedRequest } from '@07-shared/types/type';
import { createFakeSignUpData } from '@07-shared/lib/testing/user.test.factory';

import { Session } from '@06-entities/sessions';
import { userRepository, UserDoc } from '@06-entities/users';

// engine slice has no barrel index.ts yet, so deep import is currently the
// only path — replace these examples once a barrel is added
import engineRouter from '@02-processes/engine/api/engine.routes';
import { engineRegistryService } from '@02-processes/engine/services/engine-registry.service';
import { engineProxyService } from '@02-processes/engine/services/engine-proxy.service';

// ❌ import dotenv from 'dotenv';  — go through config.ts instead
```

## config

`config.ts` (`@07-shared/config/config`) is the single source of truth for env-derived
values — read the file directly for the exhaustive list. Properties in active use:

```typescript
config.env           // 'local' | 'test' | 'production'
config.port          // server port (default 5000)
config.mongoUri      // MongoDB connection string
config.jwtSecret     // { secret, expiresIn }
config.isProduction  // boolean
config.redis         // { url } — REDIS_URL, else redis://HOST:PORT fallback
config.dataEngine    // { path, baseUrl, pythonBin, secretKey } — Python engine
                     // pythonBin from DATA_ENGINE_PYTHON (default 'python')
config.geminiApiKeys // string[] — GOOGLE_API_KEY1/2/3, not a single key
config.adminEmails   // string[] — ADMIN_EMAILS, lowercase-normalized allowlist
```

## AppError

```typescript
throw new AppError('User not found', 404);
// statusCode 4xx → status: 'fail', 5xx → status: 'error'
```

## validate middleware (Zod)

```typescript
import { validate } from '@07-shared/middlewares/validate.middleware';
import { z } from 'zod';

const schema = z.object({ email: z.string().email() });
router.post('/endpoint', validate(schema), controller);
// fail → 400; success → req.body replaced with the parsed value
```

- For a route with no body, use `z.object({...}).default({})` instead of skipping validation.
- Do not modify `validate.middleware.ts` itself — resolve the issue at the schema level.

## authenticate middleware (JWT)

```typescript
// verifies the Authorization: Bearer <token> header → injects req.user.id
router.get('/protected', authenticate, controller);

const controller = (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;
};
```

## SocketService (real-time broadcast)

```typescript
SocketService.init(server); // once, after HTTP server creation

// group-scoped broadcast — the normal path for per-session EEG events
SocketService.emitToGroup(groupId, 'eeg-live', { data: [...] });

// operator-only room (subject sockets are not in it)
SocketService.emitToOperators(groupId, 'eeg-live', { data: [...] });

// all-clients broadcast — rare; only for genuinely global events
SocketService.emitLiveEvent('eeg-live', { data: [...] });

SocketService.getIO(); // throws if called before init
```

## redisService

```typescript
await redisService.connect();    // on app start
await redisService.disconnect(); // on app shutdown

// channel is per-group/subject — never a fixed name, see architecture.md
const channel = `mind-signal:${groupId}:subject:${subjectIndex}`;
redisService.client.publish(channel, JSON.stringify(data));
redisService.client.subscribe(channel, callback);
```

## Test factory

```typescript
const user = createFakeSignUpData();                          // random data
const user = createFakeSignUpData({ email: 'test@test.com' }); // partial override
```
