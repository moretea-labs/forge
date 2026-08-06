#!/usr/bin/env bun
import { runBoundedChild } from '../src/runtime/shared/bounded-child-supervisor';

interface Request {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

const encoded = process.env.FORGE_SUPERVISED_REQUEST;
if (!encoded) throw new Error('FORGE_SUPERVISED_REQUEST is required');
delete process.env.FORGE_SUPERVISED_REQUEST;
const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Request;
const result = await runBoundedChild(request.command, request.args, {
  cwd: request.cwd,
  env: process.env,
  timeoutMs: request.timeoutMs,
  maxOutputBytes: request.maxOutputBytes,
  stdio: 'capture',
  termination: { gracePeriodMs: 100, killAfterMs: 2_000, pollIntervalMs: 25 },
});
process.stdout.write(JSON.stringify(result));
