#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
const timeoutFlag = args.indexOf('--timeout-ms');
const timeoutValue = timeoutFlag >= 0 ? args[timeoutFlag + 1] : undefined;
const timeoutMs = Number(timeoutValue);
const commandArgs = separator >= 0 ? args.slice(separator + 1) : [];

if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || commandArgs.length === 0) {
  console.error('Usage: node scripts/run-bounded-command.mjs --timeout-ms <positive-integer> -- <command> [args...]');
  process.exitCode = 64;
} else {
  const [command, ...commandArguments] = commandArgs;
  const child = spawn(command, commandArguments, {
    stdio: 'inherit',
    env: process.env,
    detached: process.platform !== 'win32',
  });
  let timedOut = false;
  let launchFailed = false;
  let escalation;

  const stop = (signal) => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    console.error(`[bounded-command] Timed out after ${timeoutMs}ms: ${commandArgs.join(' ')}`);
    stop('SIGTERM');
    escalation = setTimeout(() => stop('SIGKILL'), 5_000);
    escalation.unref();
  }, timeoutMs);
  timeout.unref();

  child.once('error', (error) => {
    launchFailed = true;
    clearTimeout(timeout);
    console.error(`[bounded-command] Failed to start ${command}: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    clearTimeout(timeout);
    if (escalation) clearTimeout(escalation);
    process.exitCode = launchFailed ? 1 : (timedOut ? 124 : code ?? 1);
  });
}
