#!/usr/bin/env bun
import { runTrackedForgeHelper } from "./lib/run-forge-helper";

if (import.meta.main) runTrackedForgeHelper("capability-resolver.ts");
