# Core Concepts

## Local-first controller

Forge keeps execution and durable state on the operator-controlled machine. ChatGPT sends authenticated requests and receives bounded results; it does not become the process owner of the local runtime.

## Explicit repository scope

The controller can know many repositories, but each repository action resolves to a stable repository identity and, when needed, a checkout identity. A repository switch must be explicit.

## Durable work

Complex work is represented by persistent plans, tasks, jobs, runs, handoffs, checks, and evidence. A transport timeout does not imply that execution stopped, so status must be checked before replaying a write.

## Bounded effects

Reading, local edits, remote writes, destructive operations, and secret access are distinct effect classes. Local access mode changes convenience, not the authorization requirements for remote, destructive, or secret-bearing actions.

## Evidence before completion

A task is complete only when the relevant diff, checks, integrated revision, and cleanup state are known. Release claims require stronger evidence: exact revision identity, immutable artifacts, cold-start health, and external verification.

## Immutable runtime releases

Forge Runtime releases are built from a clean canonical source tree. Source commit, immutable manifest, service registration, active whole-release authority, database compatibility, Worker protocol, and the running Runtime identity must agree exactly.

Continue with [Work Lifecycle](Work-Lifecycle), [Security Model](Security-Model), and [Runtime Architecture](Runtime-Architecture).
