#!/usr/bin/env bun
export * from "../assets/templates/helpers/migrate-workflow-docs";
import { runTrackedForgeHelper } from "./lib/run-forge-helper";

if (import.meta.main) runTrackedForgeHelper("migrate-workflow-docs.ts");
