#!/usr/bin/env bun
export * from "../assets/templates/helpers/check-skill-version";
import { runTrackedForgeHelper } from "./lib/run-forge-helper";

if (import.meta.main) runTrackedForgeHelper("check-skill-version.ts");
