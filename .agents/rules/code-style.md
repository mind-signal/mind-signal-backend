# Code Style Rules — Mind Signal Backend

## Universal

- Indent size: 2 spaces (tabs never)
- Line length limit: 80 characters
- Trailing commas: es5 (trailing commas where valid in ES5 — objects, arrays, imports)
- End of line: LF (enforced via `.gitattributes: * text=auto eol=lf`)
- File encoding: UTF-8

## Formatter Ownership — Prettier

- Prettier owns **all** whitespace and layout decisions.
- ESLint handles semantic and logic rules only.
- Any ESLint rule that conflicts with Prettier output MUST be disabled in ESLint config.
- Run: `npm run format` (write) or `npm run format:check` (verify) — CI runs `npm run format:check`.
- Config: `.prettierrc` (tabWidth: 2, singleQuote: true, trailingComma: "es5", printWidth: 80)

## Linter — ESLint 9 flat config

- Run: `npm run lint`
- Config: `eslint.config.mjs`
- `--max-warnings 0` is enforced — zero warnings allowed, all must be fixed.
  Existing warnings are NOT exempt. "관련 없음" 핑계로 방치 금지.
- Any ESLint warning that appears in CI output must be resolved before merging.

## Naming Conventions

- **Types / Interfaces / Classes / Enums**: `PascalCase`
  - Examples: `SessionDocument`, `AppError`, `UserRole`
- **Functions / variables / object properties**: `camelCase`
  - Examples: `getUserById`, `isAuthenticated`, `engineRegistryService`
- **Constants (module-level, truly immutable)**: `SCREAMING_SNAKE_CASE`
  - Examples: `MAX_RETRY_COUNT`, `DEFAULT_TIMEOUT_MS`

## Folder Naming

- `kebab-case`, plural domain nouns
- FSD layer folders keep their number prefix as-is: `07-shared`, `06-entities`,
  `05-features`, `02-processes`, `01-app`
- New domain folders inside a layer: `kebab-case` plural
  - Examples: `neuro-chats`, `survey-responses`, `engine-proxies`

## File Naming

Single-form `kebab-case` + dot-role suffix:

| Role | Suffix | Example |
|------|--------|---------|
| Mongoose schema | `.schema.ts` | `session.schema.ts` |
| Express controller | `.controller.ts` | `auth.controller.ts` |
| Repository (DB access) | `.repository.ts` | `user.repository.ts` |
| Service (business logic) | `.service.ts` | `measurement.service.ts` |
| Router | `.routes.ts` | `chat.routes.ts` |
| Middleware | `.middleware.ts` | `validate.middleware.ts` |
| Zod schema | `.schema.ts` (same as Mongoose — use context to disambiguate) | `chat.schema.ts` |
| Type definitions | `.type.ts` or `.types.ts` | `auth.types.ts` |
| Test file | `.test.ts` | `auth.controller.test.ts` |

New tests are colocated with the source file they test (`src/**/*.test.ts`), matching
the Jest `testMatch` pattern. Do not place new tests under a root-level `__tests__/`
that sits outside `src/` — Jest will silently skip them.

## Comments — Korean Noun-Form Rule (MS-specific)

All code comments MUST end with a Korean nominal (명사형) ending.

Allowed endings: `~함`, `~완료`, `~처리`, `~반환`, `~생성`, `~사용`, `~임`

```typescript
// ✅ Correct
// 사용자 인증 처리함
// JWT 토큰 검증함
// Redis 연결 완료
// 세션 상태 업데이트 반환
// engineRegistryService 경유 URL 획득함

// ❌ Wrong
// 사용자 인증을 처리합니다
// JWT 토큰을 검증하는 함수
// Redis에 연결합니다
```

This rule applies to:
- Inline comments (`//`)
- Block comments (`/* */`)
- JSDoc description lines (`/** */`)

It does NOT apply to:
- Free-form text responses to users (answer naturally)
- Markdown documents outside code blocks

## JSDoc — Google Style

Use Google Style JSDoc for all exported functions and classes.

```typescript
/**
 * 사용자 ID로 세션 목록 조회함.
 *
 * @param userId - MongoDB ObjectId 문자열
 * @param status - 필터링할 세션 상태 (생략 시 전체 반환)
 * @returns 세션 도큐먼트 배열
 * @throws AppError 404 — 사용자 미존재 시
 */
export async function getSessionsByUser(
  userId: string,
  status?: SessionStatus,
): Promise<SessionDocument[]> { ... }
```

- `@param` descriptions must follow the noun-form comment rule.
- `@throws` must name the error class and the HTTP status code.
- Private/internal functions: JSDoc optional, inline comment sufficient.

## TypeScript — Strict Mode

`tsconfig.json` must include `"strict": true`. No relaxation of strict flags allowed.

- No `as` type assertions to bypass type checking or Zod validation.
- No `@ts-ignore` without a cited reason in the same line comment.
- `import type` MUST be used for type-only imports.

## Path Alias Usage

Always use the layer alias — never relative paths that cross layer boundaries.
See `.agents/rules/shared-utils.md` for the full alias table.

```typescript
// ✅ Correct
import { config } from '@07-shared/config/config';
import { AppError } from '@07-shared/errors';
import { Session } from '@06-entities/sessions';

// ❌ Wrong — relative path crossing layer boundary
import { AppError } from '../../../07-shared/errors';
```

Intra-slice imports (within the same slice folder) may use relative paths.

## Module Export Rules

- Every FSD slice exposes its public interface through `index.ts` only.
- Do not import directly from internal files of another slice.
- See `.agents/rules/architecture.md` for full FSD boundary rules.
