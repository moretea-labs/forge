# Thin Harness Governance Policy

## Purpose

Preserve thin harness performance goals while allowing controlled workflow evolution.

## Execution routing

Direct edit is the default path for bounded, low-risk changes. Escalate to Requirement/Issue/Work only when complexity requires lifecycle tracking, parallelism, long-running execution, or additional protection.

Priority order:

1. Direct edit
2. Requirement/workflow
3. Issue/task orchestration
4. Durable Goal Workloop / PlanContract coordination

## Architecture strategy changes

The following changes require explicit user approval before migration:

- changing the default execution mode
- replacing direct execution with mandatory orchestration
- changing thin harness performance goals
- introducing additional lifecycle layers that affect latency
- changing authority models or user entry points

Storage migrations must not silently change user workflow semantics.

## Conflict handling

When a refactor conflicts with an established architecture strategy, report the conflict and request approval instead of silently applying the new strategy.
