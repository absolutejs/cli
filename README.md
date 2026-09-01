# @absolutejs/cli

Operations CLI used by the hosted AbsoluteJS.ai platform and self-hosted Bun deployments. Verbs over
[`@absolutejs/secrets`](https://github.com/absolutejs/secrets) and
[`@absolutejs/deploy`](https://github.com/absolutejs/deploy):

```
absolutejs secrets list                  list secret names + fingerprints
absolutejs secrets rotate STRIPE_KEY     generate + persist a new value
absolutejs env push prod                 push resolved env file to a stage
absolutejs env diff prod                 see what `env push` would change
absolutejs deploy rollback prod          roll back to the previous release
absolutejs db check-drift                do the migrations cover the schema?
absolutejs db verify-contract            is anything destructive in the wrong phase?
```

Sibling to [`@absolutejs/absolute`](https://github.com/absolutejs/absolute)
(framework CLI: `dev`, `start`, `compile`, etc.). They're complementary —
`absolute` is `dev/build/codegen`, `absolutejs` is
`secrets/env/deploy/diagnostics`.

## Install

```bash
bun add -d @absolutejs/cli
```

The `absolutejs` binary lands in `node_modules/.bin/`. Run via `bunx
absolutejs`, `npx absolutejs`, or alias it in your shell.

## Config — `absolutejs.config.ts`

Drop one in your project root. The CLI walks up from the cwd to find it.

```ts
import { defineConfig } from "@absolutejs/cli";
import { createSecretBroker, encryptedFileAdapter } from "@absolutejs/secrets";
import { hetznerTarget } from "@absolutejs/deploy/hetzner";
import { createDeployer } from "@absolutejs/deploy";

const adapter = encryptedFileAdapter({
  path: "./.secrets.enc.json",
  key: {
    type: "passphrase",
    passphrase: process.env.SECRETS_MASTER!,
  },
});

const broker = createSecretBroker({ adapter });

const prodTarget = () =>
  hetznerTarget({
    token: process.env.HETZNER_TOKEN!,
    name: "api-prod-1",
    region: "nbg1",
    serverType: "cx22",
    image: "ubuntu-22.04",
    sshKeys: [process.env.HETZNER_KEY_FINGERPRINT!],
  });

export default defineConfig({
  secrets: broker,
  secretAdapter: adapter,
  deployments: [
    {
      name: "prod",
      target: prodTarget,
      remotePath: "/etc/api.env",
      secretNames: ["DATABASE_URL", "STRIPE_KEY"],
      extras: { NODE_ENV: "production" },
      reload: "systemctl reload api",
      deployer: async () =>
        createDeployer({
          appName: "api",
          target: await prodTarget(),
        }),
    },
  ],
});
```

The `target` and `deployer` fields are LAZY (`() => …`). Verbs that
don't touch a remote (`secrets list`, `secrets set`) never invoke
them — `absolutejs secrets list` won't accidentally provision a
Hetzner box.

## Commands

### `secrets`

| Verb                  | Description                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `list`                | Print every name + fingerprint from the adapter. Plaintext never appears.                 |
| `get <name> [--show]` | Resolve one secret. Default prints `fingerprint=` only; `--show` prints plaintext.        |
| `set <NAME>=<value>`  | Put a value via the configured adapter.                                                   |
| `rotate <name>`       | Call `broker.rotate(name)` — generates a new value, persists, fires `onRotate` listeners. |

### `env`

| Verb                   | Description                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `push <stage>`         | Resolve `secretNames` + `extras` for the stage, atomic-write the remote env file, run `reload`.                                        |
| `pull <stage>`         | Read the remote env file as-is.                                                                                                        |
| `diff <stage> [--all]` | Show added/changed/removed keys between what `push` would write and what's currently on the remote. `--all` also lists unchanged keys. |

### `deploy`

| Verb                           | Description                                  |
| ------------------------------ | -------------------------------------------- |
| `releases <stage>`             | List release history for a stage.            |
| `status <stage>`               | Current release id + recent history.         |
| `rollback <stage> [--to <id>]` | Roll back to `--to` or the previous release. |

### `diagnostics`

These commands do not require `absolutejs.config.ts`.

| Verb                  | Description                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture <url>`       | Open an isolated Chrome support session with cache disabled and preserved navigation history. Produces an audited HAR, console log, and UTC metadata file. Type markers in the terminal; submit an empty line to stop. |
| `redact <input.har>`  | Redact an existing DevTools HAR to a new file. Refuses to overwrite the source or an existing output.                                                                                                                  |
| `audit <artifact>`    | Exit non-zero when an artifact contains credential, cookie, JWT, payment-card, or sensitive-field evidence.                                                                                                            |
| `inspect <input.har>` | Summarize entries, failed requests, aggregate timing, and privacy-audit state.                                                                                                                                         |

```bash
absolutejs diagnostics capture https://example.com/checkout
absolutejs diagnostics capture https://example.com/checkout --duration 120
absolutejs diagnostics redact chrome-export.har --output vendor.redacted.har
absolutejs diagnostics audit vendor.redacted.har
absolutejs diagnostics inspect vendor.redacted.har --json
```

Capture bodies from a DevTools HAR are removed unless Diagnostics is configured
with an explicit per-request retention policy. Raw temporary Playwright HARs are
removed in a `finally` block after the redacted artifact is flushed and audited.

### `db` — migration phase gates

Zero-downtime deploys run two binaries against one database: the old slot is
still serving while the new one boots. A migration that drops or renames
something the old slot still selects takes that slot down mid-deploy. So a
migration is split — `migration.sql` may only add, and anything destructive
moves to `contract.sql`, which runs after the old slot has drained.

```bash
absolutejs db check-drift                     # offline: do migrations cover the schema?
absolutejs db verify-contract --since <id>    # offline: anything destructive in the wrong phase?
absolutejs db verify-schema --schema db/schema.ts   # live: can the new build run against this?
absolutejs db contract-migrate --since <id>   # live: apply the post-drain half
```

In a pipeline, in order: `check-drift` and `verify-contract` before anything is
built; `drizzle-kit migrate` then `verify-schema` before the new slot is
activated; `contract-migrate` after the old slot is gone.

`check-drift` runs the generator under a marker name and looks at what it wanted
to write. A schema file is not the whole schema surface — constants it imports
are schema too, so editing one without regenerating produces drift that
typecheck, lint and tests all miss and that surfaces as a failed deploy. Nothing
contacts a database.

`verify-schema` is deliberately one-directional. Missing tables, missing columns,
and columns the code treats as `NOT NULL` that the database allows to be null
are failures, because the new binary would break on them. Objects the database
has and the code does not are **not** failures — during expand/contract that is
exactly the expected state between migrate and the post-drain step.

`contract-migrate` applies each file in one transaction with an advisory lock and
its ledger row, so two deploys racing cannot both apply it and a crash cannot
leave it applied-but-unrecorded.

`--since <migration-id>` marks migrations that predate the policy, so adopting it
on an existing project does not mean rewriting history. `--dir` (default
`drizzle`), `--ledger`, `--lock` and `--url` cover the rest; `--url` falls back
to `DATABASE_URL`.

### Global flags

- `--json` — machine-readable output.
- `--help` — top-level banner.

## Composition with the rotation loop

```bash
# Rotate STRIPE_KEY in the broker.
absolutejs secrets rotate STRIPE_KEY

# Push to every deployment that uses it.
absolutejs env push prod
absolutejs env push staging
```

`broker.rotate` fires the in-process `onRotate` listeners (long-lived
DB clients swap creds in place); `env push` propagates to the remote
boxes and reloads the services.

## License

BSL-1.1 with named carveout. Change date: 2030-05-31 (Apache 2.0).
