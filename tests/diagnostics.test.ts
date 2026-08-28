import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiagnostics } from "../src/commands/diagnostics";
import { main } from "../src/cli";
import { redactHarText } from "@absolutejs/diagnostics/redact";

const rawHar = (secret: string): string =>
  JSON.stringify({
    log: {
      entries: [
        {
          request: {
            cookies: [],
            headers: [{ name: "authorization", value: `Bearer ${secret}` }],
            method: "POST",
            queryString: [{ name: "token", value: secret }],
            url: `https://provider.test/pay?token=${secret}`,
          },
          response: {
            content: {},
            cookies: [],
            headers: [],
            status: 500,
          },
          time: 42,
        },
      ],
      version: "1.2",
    },
  });

describe("diagnostics CLI", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdir(
      join(tmpdir(), `absolute-diagnostics-${crypto.randomUUID()}`),
      { recursive: true },
    ).then((value) => value ?? "");
  });
  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  test("redacts to a new file and never mutates the source HAR", async () => {
    const secret = "provider-secret-token-123456789";
    const input = join(directory, "source.har");
    const output = join(directory, "sendable.har");
    const source = rawHar(secret);
    await writeFile(input, source);

    expect(
      await runDiagnostics(
        {
          flags: { output },
          positional: [input],
          verb: "redact",
        },
        "json",
      ),
    ).toBe(0);
    expect(await readFile(input, "utf8")).toBe(source);
    expect(await readFile(output, "utf8")).not.toContain(secret);
    expect(
      await runDiagnostics(
        { flags: {}, positional: [output], verb: "audit" },
        "json",
      ),
    ).toBe(0);
  });

  test("inspect summarizes failures and privacy state", async () => {
    const input = join(directory, "capture.har");
    await writeFile(
      input,
      redactHarText(rawHar("private-provider-token-123456")).text,
    );
    expect(
      await runDiagnostics(
        { flags: {}, positional: [input], verb: "inspect" },
        "json",
      ),
    ).toBe(0);
  });

  test("top-level diagnostics commands do not require a project config", async () => {
    const input = join(directory, "sendable.har");
    await writeFile(
      input,
      redactHarText(rawHar("private-provider-token-123456")).text,
    );
    expect(await main(["diagnostics", "audit", input, "--json"])).toBe(0);
  });
});
