# Dependency and supply-chain hygiene

Reviewed 2026-10-13. This is the record for override floors, the audit ignore
list, dependencies held for a later issue, and major upgrades that stay deferred.

## Overrides

`pnpm.overrides` targets are caret ranges (`^x.y.z`). An open `>=` floor is not
used, because it can float a patched package onto a later major.

| Override                                  | Target                | Why                                                                                     |
| ----------------------------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `esbuild@<=0.24.2`                        | `^0.25.0`             | Security floor for the old esbuild line. Newer esbuild dependencies are left alone.     |
| `file-type@>=13.0.0 <21.3.1`              | `^21.3.1`             | Patches the vulnerable range without floating those copies onto file-type 22.           |
| `uuid@<11.1.1`                            | `^11.1.1`             | Security floor. The app uses `uuidv7`, not `uuid`.                                      |
| `postcss@<8.5.18`                         | `^8.5.18`             | Security floor. The older `postcss@<8.5.10` override was the same rule and was removed. |
| `nanoid@<3.3.18`                          | `^3.3.18`             | Keeps transitive nanoid 3 on the patched 3.x line.                                      |
| `browserslist@<=4.28.6`                   | `^4.28.7`             | Security floor.                                                                         |
| `@opentelemetry/propagator-jaeger@<2.9.0` | `^2.9.0`              | Jaeger propagator only. Remove with the OpenTelemetry upgrade in #30.                   |
| `ioredis`, `form-data`, `vite`            | existing caret ranges | Already capped. `vite` stays on 6.x for the current Vitest toolchain.                   |

The `next@<16.3.3` override was removed. `next` is pinned exactly to `16.3.6`, which is already above that floor. Further Next bumps stay on #33.

The direct `file-type` dependency is `^22.1.1`. The previous `^19.5.0` range was already installed as 22.x by the open override. Declaring 22 matches that install and stays on the current major.

## Ignored advisories

`package.json` `pnpm.auditConfig.ignoreGhsas` is the only ignore list. `pnpm audit --prod` is the blocking gate in `.github/workflows/security.yml`.

| Advisory                                                                 | Reviewed   | Tracking                                              | Remove when |
| ------------------------------------------------------------------------ | ---------- | ----------------------------------------------------- | ----------- |
| [GHSA-q7rr-3cgh-j5r3](https://github.com/advisories/GHSA-q7rr-3cgh-j5r3) | 2026-10-13 | [#30](https://github.com/yumaitau/BlakPath/issues/30) | #30 lands   |

GHSA-q7rr-3cgh-j5r3 is a crash in the OpenTelemetry Prometheus exporter. BlakPath ships the OTLP/HTTP exporter only, so that module is not loaded. Do not add an ignore without a row in this table.

## Unused dependencies

Removed because nothing imports them: `react-hook-form`, `@hookform/resolvers`, `@radix-ui/react-dialog`, `@radix-ui/react-tabs`, `@radix-ui/react-toast`.

Held until [#75](https://github.com/yumaitau/BlakPath/issues/75) adds component tests:

| Package                  | Why it stays                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@testing-library/react` | No importer yet. Ignored by Knip and depcheck. Delete the ignores when #75 imports it.                                             |
| `jsdom`                  | Installed for the jsdom Vitest environment #75 will turn on. Current Vitest wiring already keeps the tools from calling it unused. |

These references are real, but the tools cannot see them. They are ignored so the gate does not report them as unused:

| Package                       | Reference                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pino-pretty`                 | String transport target in `src/lib/observability/logger.ts`. Dev-only; not imported, so production install does not load it. |
| `@tailwindcss/postcss`        | Plugin key in `postcss.config.mjs`.                                                                                           |
| `tailwindcss`                 | `@import` in `src/styles/globals.css`.                                                                                        |
| `prettier-plugin-tailwindcss` | Plugin name in `.prettierrc.json`.                                                                                            |
| `@worker/*`                   | TypeScript path alias (`@worker/scheduler`), not an npm package. depcheck only.                                               |

`pnpm deps:check` runs Knip (dependencies and devDependencies only) and depcheck. Unused files and unused exports are out of scope here; see #78.

## Major versions

Production dependencies are at most one major behind the version reviewed on 2026-10-13. Nothing in `dependencies` is further behind. These one-major upgrades are deferred because each changes a public API and should land in its own wave:

| Package          | Declared                 | Latest on 2026-10-13 | Wave                                  |
| ---------------- | ------------------------ | -------------------- | ------------------------------------- |
| `bullmq`         | 5.21                     | 6.3.14               | Queue client, together with `ioredis` |
| `ioredis`        | 5.4 (override `^5.11.1`) | 6.0.0                | With `bullmq`                         |
| `pino`           | 9.5                      | 10.4.0               | Logger                                |
| `lucide-react`   | 0.454                    | 1.56.0               | Icon exports                          |
| `tailwind-merge` | 2.5                      | 3.7.0                | Class merger                          |
| `nanoid`         | 5.1                      | 6.0.2                | Id helpers                            |
| `nodemailer`     | 9.1                      | 10.1.0               | Mail transport                        |

Dev tooling, also deferred (not production dependencies):

| Package         | Declared | Latest on 2026-10-13 | Notes                                                  |
| --------------- | -------- | -------------------- | ------------------------------------------------------ |
| `typescript`    | 5.6      | 7.0.2                | Two majors. Typecheck gate.                            |
| `vitest`        | 3.2      | 5.0.4                | Two majors. Test runner.                               |
| `eslint`        | 9.13     | 10.12.0              | One major. Flat config is already in use.              |
| `dotenv`        | 16.4     | 18.0.7               | Two majors. Used by migrate, seed, and Drizzle config. |
| `vite` override | 6.4.3    | 8.3.4                | Left capped for Vitest 3.                              |

OpenTelemetry `sdk-node`, the OTLP exporter, and auto-instrumentations are still on the 0.5x line while current 0.x releases are 0.81 / 0.223. That upgrade is #30, not this change. The Jaeger propagator override stays until that upgrade.

## Actions and images

GitHub Actions in `.github/workflows` are pinned to a 40-character commit SHA, with the tag in a comment. Workflow runner labels are unchanged.

Local and example images use a version tag. Production web and worker defaults are `ghcr.io/yumaitau/blakpath:0.1.0` and `ghcr.io/yumaitau/blakpath-worker:0.1.0`. Set `WEB_IMAGE` and `WORKER_IMAGE` to the digest that a release actually published. The MinIO and `mc` tags are the last community releases (`RELEASE.2025-10-15T17-29-55Z` and `RELEASE.2025-08-13T08-35-41Z`).
