import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { configureBrainRoot, defaultBrainRootChoice, expandHomePath } from "./brain-root";
import { runInstall, type InstallTargetSpec } from "./install";
import { runProcess as runBoundedProcess } from "../../effects/process-runner";
import { runSetupProcess as runProcess, withProcessEnv, type SetupExecutionStep } from './setup-execution';

export interface GlobalRuntimeOptions {
  sourceRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  target?: InstallTargetSpec;
  installCli?: boolean;
  installSpec?: string;
  hostAdapters?: boolean;
  brainRoot?: string;
}

export type GlobalRuntimeStep = SetupExecutionStep;

export interface GlobalRuntimeResult {
  exitCode: number;
  steps: GlobalRuntimeStep[];
  lines: string[];
  stdout: string;
  stderr: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function defaultSourceRoot(): string {
  return join(SCRIPT_DIR, "..", "..", "..");
}

function withStepName(step: GlobalRuntimeStep, name: string, detail?: string): GlobalRuntimeStep {
  return { ...step, step: name, detail: detail ?? step.detail };
}

function renderStep(step: GlobalRuntimeStep): string[] {
  const lines = [`[runtime] ${step.status}: ${step.step}${step.detail ? ` - ${step.detail}` : ""}`];
  if (step.status === "failed" && step.stderr?.trim()) lines.push(step.stderr.trim());
  return lines;
}

function packageVersion(sourceRoot: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch (_error) {
    return null;
  }
}

function commandAvailable(command: string, cwd: string, env?: NodeJS.ProcessEnv): boolean {
  return runBoundedProcess(command, ["--version"], {
    cwd,
    env,
    timeoutMs: 5_000,
    maxOutputBytes: 2_000,
  }).ok;
}

function installCli(sourceRoot: string, cwd: string, env?: NodeJS.ProcessEnv, installSpec?: string): GlobalRuntimeStep {
  const spec = installSpec ?? (existsSync(join(sourceRoot, "package.json")) ? sourceRoot : "forge");
  const step = commandAvailable("bun", cwd, env)
    ? runProcess("bun", ["add", "-g", spec], cwd, env)
    : runProcess("npm", ["install", "-g", spec, "--omit=optional", "--no-audit", "--no-fund"], cwd, env);
  const version = packageVersion(sourceRoot);
  return withStepName(
    step,
    "install forge CLI",
    installSpec ? `spec=${installSpec}` : version ? `version=${version}` : undefined,
  );
}

function installHostAdapters(target: InstallTargetSpec, env?: NodeJS.ProcessEnv): GlobalRuntimeStep {
  const installed = withProcessEnv(env, () => runInstall({ target, location: "global" }));
  return {
    step: "install host adapters",
    status: installed.exitCode === 0 ? "ok" : "failed",
    detail: installed.lines.join("; "),
  };
}

function configureBrain(root: string | undefined, env?: NodeJS.ProcessEnv): GlobalRuntimeStep {
  try {
    const selected = root
      ? resolve(expandHomePath(root, env))
      : defaultBrainRootChoice({ env }).root;
    const configured = configureBrainRoot(selected, env);
    return {
      step: "configure brain root",
      status: "ok",
      detail: `${configured.root} (${configured.path})`,
    };
  } catch (error) {
    return {
      step: "configure brain root",
      status: "failed",
      stderr: String((error as Error).message ?? error),
    };
  }
}

export function runGlobalRuntimeSetup(opts: GlobalRuntimeOptions = {}): GlobalRuntimeResult {
  const sourceRoot = opts.sourceRoot ?? defaultSourceRoot();
  const cwd = opts.cwd ?? process.cwd();
  const target = opts.target ?? "both";
  const env = opts.env;
  const steps: GlobalRuntimeStep[] = [];

  if (opts.installCli !== false) steps.push(installCli(sourceRoot, cwd, env, opts.installSpec));
  else steps.push({ step: "install forge CLI", status: "skipped", detail: "disabled" });

  if (opts.hostAdapters !== false) steps.push(installHostAdapters(target, env));
  else steps.push({ step: "install host adapters", status: "skipped", detail: "disabled" });

  steps.push(configureBrain(opts.brainRoot, env));

  const lines = steps.flatMap(renderStep);
  const failed = steps.some((step) => step.status === "failed");
  return {
    exitCode: failed ? 1 : 0,
    steps,
    lines,
    stdout: lines.join("\n"),
    stderr: steps.filter((step) => step.status === "failed").map((step) => step.stderr ?? "").filter(Boolean).join("\n"),
  };
}
