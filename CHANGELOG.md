# @absolutejs/cli changelog

## 0.1.0 — 2026-05-31

Initial release. Closes G8 from the second-pass PaaS audit (the
"substrate is a library, not a platform" gap).

### Added

- **`absolutejs` binary** — config-file-driven CLI dispatched via
  `bin/absolutejs.js`. Walks up from cwd to find
  `absolutejs.config.ts` (also `.mts` / `.js` / `.mjs`).
- **`defineConfig({ secrets, secretAdapter, deployments })`** —
  identity helper for type inference + future extension.
- **Narrow interfaces** — `CliSecretBroker`, `CliSecretAdapter`,
  `CliTarget`, `CliDeployer`, `CliDeployment` — `@absolutejs/secrets`'
  `SecretBroker` and `@absolutejs/deploy`'s `Target` / `Deployer`
  satisfy them structurally. No hard dep either direction.
- **`secrets list / get / set / rotate`** — broker + adapter
  introspection + rotation. `get` redacts by default (`--show` to
  print plaintext).
- **`env push / pull / diff`** — atomic remote env-file management.
  Resolves the deployment's lazy `target()` factory only when needed
  (a `secrets list` doesn't accidentally provision a box).
- **`deploy releases / status / rollback`** — release-history ops
  over `@absolutejs/deploy`'s existing primitives. `rollback`
  without `--to` picks the previous release.
- **`--json` flag** — machine-readable output across every verb.
- **Hand-rolled arg parser** — no commander / yargs dep, consistent
  with the substrate's zero-peer-dep posture.

### Operational notes

- **Lazy target/deployer factories.** `CliDeployment.target` and
  `.deployer` are `() => Promise<...>`. The CLI invokes them only
  for verbs that need a remote. This keeps `secrets` verbs cheap.
- **Plaintext discipline.** `secrets list` only prints names +
  fingerprints. `secrets get` redacts by default. Use `--show` when
  you actually need the value piped somewhere.
- **Atomic writes.** `env push` uses the same temp-file + `mv`
  pattern as `@absolutejs/deploy/env` — a partially-written env
  file never reaches a service.

### Tests

27 tests covering arg parsing, every secrets / env / deploy verb,
broker / adapter / target / deployer mocks, lazy-factory invocation
behavior, config discovery (cwd + walk-up), missing-config error.

### License

BSL-1.1 with named carveout. Change date: 2030-05-31 (Apache 2.0).
Competing-service clause names: Vercel CLI, Railway CLI, Fly CLI,
Render CLI, Heroku CLI, Cloudflare Workers CLI, Supabase CLI, AWS
Amplify CLI, Convex CLI.
