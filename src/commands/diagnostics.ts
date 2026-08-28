import { access, readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  auditDiagnosticText,
  redactHarText,
} from "@absolutejs/diagnostics/redact";
import { launchPlaywrightHarCapture } from "@absolutejs/diagnostics/playwright";
import type { OutputMode } from "../utils/output";
import { writeJson, writeOut } from "../utils/output";

export type DiagnosticsArgs = {
  flags: Record<string, string | boolean>;
  positional: string[];
  verb: string;
};

const stringFlag = (
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined => {
  const value = flags[name];
  if (typeof value === "boolean") throw new Error(`--${name} requires a value`);
  return value;
};

const outputFor = (input: string): string => {
  const extension = extname(input);
  return resolve(
    `${input.slice(0, extension === "" ? input.length : -extension.length)}.redacted.har`,
  );
};

const requireAbsent = async (paths: string[]): Promise<void> => {
  for (const path of paths) {
    try {
      await access(path);
      throw new Error(`refusing to overwrite existing artifact: ${path}`);
    } catch (caught) {
      if (
        caught instanceof Error &&
        "code" in caught &&
        caught.code === "ENOENT"
      ) {
        continue;
      }
      throw caught;
    }
  }
};

const summaryFromHar = (text: string) => {
  const parsed = JSON.parse(text) as {
    log?: {
      entries?: Array<{
        request?: { method?: string; url?: string };
        response?: { status?: number };
        time?: number;
      }>;
      version?: string;
    };
  };
  const entries = Array.isArray(parsed.log?.entries) ? parsed.log.entries : [];
  const failed = entries.filter((entry) => {
    const status = entry.response?.status ?? 0;
    return status === 0 || status >= 400;
  });
  return {
    audit: auditDiagnosticText(text),
    entries: entries.length,
    failed: failed.length,
    failedRequests: failed.slice(0, 100).map((entry) => ({
      method: entry.request?.method ?? "GET",
      status: entry.response?.status ?? 0,
      url: entry.request?.url ?? "",
    })),
    totalTimeMs: entries.reduce(
      (total, entry) => total + Math.max(0, entry.time ?? 0),
      0,
    ),
    version: parsed.log?.version ?? "unknown",
  };
};

const printSummary = (
  summary: ReturnType<typeof summaryFromHar>,
  mode: OutputMode,
): void => {
  if (mode === "json") return writeJson(summary);
  writeOut(
    [
      `HAR ${summary.version}`,
      `entries: ${summary.entries}`,
      `failed requests: ${summary.failed}`,
      `aggregate request time: ${summary.totalTimeMs.toFixed(2)}ms`,
      `privacy audit: ${summary.audit.safeToShare ? "safe to share" : "FAILED"}`,
      ...summary.failedRequests.map(
        (request) => `${request.status}  ${request.method}  ${request.url}`,
      ),
    ].join("\n"),
  );
};

const durationFlag = (
  flags: Record<string, string | boolean>,
): number | undefined => {
  const raw = stringFlag(flags, "duration");
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3_600) {
    throw new Error("--duration must be between 0 and 3600 seconds");
  }
  return seconds * 1_000;
};

const waitForCaptureStop = async (
  mark: (label: string) => void,
  durationMs: number | undefined,
): Promise<void> => {
  if (durationMs !== undefined) {
    await Bun.sleep(durationMs);
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error("capture requires an interactive terminal or --duration");
  }
  writeOut(
    "Type a marker and press Enter. Submit an empty line to stop and redact the capture.",
  );
  const lines = createInterface({ input: process.stdin, terminal: true });
  try {
    for await (const line of lines) {
      const label = line.trim();
      if (label === "") break;
      mark(label);
      writeOut(`marker: ${label}`);
    }
  } finally {
    lines.close();
  }
};

export const runDiagnostics = async (
  args: DiagnosticsArgs,
  mode: OutputMode,
): Promise<number> => {
  switch (args.verb) {
    case "redact": {
      const input = args.positional[0];
      if (input === undefined)
        throw new Error(
          "usage: diagnostics redact <input.har> [--output path]",
        );
      const output = resolve(
        stringFlag(args.flags, "output") ?? outputFor(input),
      );
      const result = redactHarText(await readFile(resolve(input), "utf8"));
      if (!result.audit.safeToShare) {
        throw new Error("redacted HAR failed the sharing audit");
      }
      await writeFile(output, `${result.text}\n`, { flag: "wx" });
      if (mode === "json") writeJson({ audit: result.audit, output });
      else writeOut(`wrote audited HAR: ${output}`);
      return 0;
    }
    case "audit": {
      const input = args.positional[0];
      if (input === undefined)
        throw new Error("usage: diagnostics audit <artifact>");
      const audit = auditDiagnosticText(await readFile(resolve(input), "utf8"));
      if (mode === "json") writeJson(audit);
      else
        writeOut(
          audit.safeToShare
            ? "privacy audit passed: safe to share"
            : `privacy audit FAILED: ${audit.findings.map((finding) => finding.code).join(", ")}`,
        );
      return audit.safeToShare ? 0 : 1;
    }
    case "inspect": {
      const input = args.positional[0];
      if (input === undefined)
        throw new Error("usage: diagnostics inspect <input.har>");
      printSummary(
        summaryFromHar(await readFile(resolve(input), "utf8")),
        mode,
      );
      return 0;
    }
    case "capture": {
      const url = args.positional[0] ?? stringFlag(args.flags, "url");
      if (url === undefined)
        throw new Error("usage: diagnostics capture <url> [--output path]");
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("capture URL must use HTTP or HTTPS");
      }
      const stem = resolve(
        stringFlag(args.flags, "output") ??
          `support-${parsed.hostname}-${new Date().toISOString().replaceAll(":", "-")}`,
      ).replace(/\.har$/u, "");
      const outputPath = `${stem}.redacted.har`;
      const consoleOutputPath = `${stem}.console.log`;
      const metadataOutputPath = `${stem}.metadata.json`;
      await requireAbsent([outputPath, consoleOutputPath, metadataOutputPath]);
      const capture = await launchPlaywrightHarCapture({
        cacheDisabled: true,
        channel: stringFlag(args.flags, "channel") ?? "chrome",
        consoleOutputPath,
        headless: args.flags.headless === true,
        metadataOutputPath,
        outputPath,
        ...(stringFlag(args.flags, "profile") === undefined
          ? {}
          : { userDataDir: resolve(stringFlag(args.flags, "profile")!) }),
        url: parsed.toString(),
      });
      const initialMarker = stringFlag(args.flags, "marker");
      if (initialMarker !== undefined) capture.mark(initialMarker);
      try {
        await waitForCaptureStop(
          (label) => capture.mark(label),
          durationFlag(args.flags),
        );
      } finally {
        await capture.stop();
      }
      const summary = summaryFromHar(await readFile(outputPath, "utf8"));
      const result = {
        ...summary,
        console: consoleOutputPath,
        har: outputPath,
        metadata: metadataOutputPath,
      };
      if (mode === "json") writeJson(result);
      else {
        writeOut(`wrote ${basename(outputPath)}`);
        writeOut(`wrote ${basename(consoleOutputPath)}`);
        writeOut(`wrote ${basename(metadataOutputPath)}`);
      }
      return 0;
    }
    default:
      throw new Error(
        `unknown diagnostics verb: "${args.verb}". try: capture | redact | audit | inspect`,
      );
  }
};
