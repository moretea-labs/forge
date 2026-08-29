#!/usr/bin/env bun
export * from "../assets/templates/helpers/workflow-contract";
import { runTrackedForgeHelper } from "./lib/run-forge-helper";

if (import.meta.main) runTrackedForgeHelper("workflow-contract.ts");
