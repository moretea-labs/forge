# Forge Wiki

Forge is a local-first action assistant that gives ChatGPT a durable, policy-bounded execution layer for local software work. The product is intentionally Direct-first: ordinary bounded work stays lightweight, while Process Runtime, Work, worktrees, scheduling, and Recovery exist for the cases that actually need lifecycle or isolation.

## Start here

- New user: [Quick Start](Quick-Start)
- Installation choices: [Installation](Installation)
- Product model: [Core Concepts](Core-Concepts)
- Request-to-evidence flow: [Work Lifecycle](Work-Lifecycle)
- System boundaries: [Architecture](Architecture)
- Runtime behavior: [Runtime Architecture](Runtime-Architecture)
- Source implementation map: [Implementation](Implementation)
- Run and recover the service: [Operations](Operations)
- Optional capabilities: [Integrations](Integrations)
- Diagnose a problem: [Troubleshooting](Troubleshooting)
- Trust boundaries: [Security Model](Security-Model)
- Upgrade or publish: [Releases and Upgrades](Releases-and-Upgrades)

## Current baseline

The normal ChatGPT connector uses a bounded 19-tool surface with five preferred facades. Small understood work can go directly from context to patch to verification. Long commands and checks use the managed Process Runtime; separate worktrees are used when concurrency or isolation actually requires them. One Canonical Forge Runtime owns active execution authority, while standalone Recovery remains an independent failure domain.

Plugin capability completeness is deliberately separate from the core Runtime baseline: a plugin can be unavailable without redefining whether repository execution, Process Runtime, or Runtime recovery is correct.

## What belongs where

The Wiki explains stable concepts, architecture, implementation boundaries, and common operator decisions. Exact source contracts, compatibility matrices, tests, and incident procedures remain versioned in the [repository documentation](https://github.com/moretea-labs/forge/tree/main/docs). When Wiki content and repository source disagree, the versioned repository source is authoritative.

## Project links

- [Repository](https://github.com/moretea-labs/forge)
- [Documentation hub](https://github.com/moretea-labs/forge/blob/main/docs/README.md)
- [Issues](https://github.com/moretea-labs/forge/issues)
- [Support](https://github.com/moretea-labs/forge/blob/main/SUPPORT.md)
- [Security policy](https://github.com/moretea-labs/forge/blob/main/SECURITY.md)
