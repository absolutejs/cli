# @absolutejs/cli

Substrate CLI for the AbsoluteJS PaaS. Verbs over
[`@absolutejs/secrets`](https://github.com/absolutejs/secrets) and
[`@absolutejs/deploy`](https://github.com/absolutejs/deploy):

```
absolutejs secrets list                  list secret names + fingerprints
absolutejs secrets rotate STRIPE_KEY     generate + persist a new value
absolutejs env push prod                 push resolved env file to a stage
absolutejs env diff prod                 see what `env push` would change
absolutejs deploy rollback prod          roll back to the previous release
```

Sibling to [`@absolutejs/absolute`](https://github.com/absolutejs/absolute)
(framework CLI: `dev`, `start`, `compile`, etc.). They're complementary —
`absolute` is `dev/build/codegen`, `absolutejs` is `secrets/env/deploy`.

## Install

```bash
bun add -d @absolutejs/cli
```

The `absolutejs` binary lands in `node_modules/.bin/`. Run via `bunx
absolutejs`, `npx absolutejs`, or alias it in your shell.

## Config — `absolutejs.config.ts`

Drop one in your project root. The CLI walks up from the cwd to find it.

```ts
import { defineConfig } from '@absolutejs/cli';
import {
  createSecretBroker,
  encryptedFileAdapter,
} from '@absolutejs/secrets';
import { hetznerTarget } from '@absolutejs/deploy/hetzner';
import { createDeployer } from '@absolutejs/deploy';

const adapter = encryptedFileAdapter({
  path: './.secrets.enc.json',
  key: {
    type: 'passphrase',
    passphrase: process.env.SECRETS_MASTER!,
  },
});

const broker = createSecretBroker({ adapter });

const prodTarget = () =>
  hetznerTarget({
    token: process.env.HETZNER_TOKEN!,
    name: 'api-prod-1',
    region: 'nbg1',
    serverType: 'cx22',
    image: 'ubuntu-22.04',
    sshKeys: [process.env.HETZNER_KEY_FINGERPRINT!],
  });

export default defineConfig({
  secrets: broker,
  secretAdapter: adapter,
  deployments: [
    {
      name: 'prod',
      target: prodTarget,
      remotePath: '/etc/api.env',
      secretNames: ['DATABASE_URL', 'STRIPE_KEY'],
      extras: { NODE_ENV: 'production' },
      reload: 'systemctl reload api',
      deployer: async () =>
        createDeployer({
          appName: 'api',
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

| Verb | Description |
| --- | --- |
| `list` | Print every name + fingerprint from the adapter. Plaintext never appears. |
| `get <name> [--show]` | Resolve one secret. Default prints `fingerprint=` only; `--show` prints plaintext. |
| `set <NAME>=<value>` | Put a value via the configured adapter. |
| `rotate <name>` | Call `broker.rotate(name)` — generates a new value, persists, fires `onRotate` listeners. |

### `env`

| Verb | Description |
| --- | --- |
| `push <stage>` | Resolve `secretNames` + `extras` for the stage, atomic-write the remote env file, run `reload`. |
| `pull <stage>` | Read the remote env file as-is. |
| `diff <stage> [--all]` | Show added/changed/removed keys between what `push` would write and what's currently on the remote. `--all` also lists unchanged keys. |

### `deploy`

| Verb | Description |
| --- | --- |
| `releases <stage>` | List release history for a stage. |
| `status <stage>` | Current release id + recent history. |
| `rollback <stage> [--to <id>]` | Roll back to `--to` or the previous release. |

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
