#!/usr/bin/env bun
export * from "../assets/templates/helpers/inspect-project-state";
import { runTrackedForgeHelper } from "./lib/run-forge-helper";

if (import.meta.main) runTrackedForgeHelper("inspect-project-state.ts");
