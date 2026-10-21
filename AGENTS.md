# Workbench

This repository holds independently published npm packages for Pi. Before adding or changing a package, read [docs/PACKAGES.md](docs/PACKAGES.md) for the complete directory structure, manifest examples, and package-specific release commands.

## Required structure

- The root `package.json` is private and declares `packages/*` as npm workspaces. Never publish the root or add a root Pi manifest that loads every package.
- Each directory directly under `packages/` is one npm package with its own `package.json`, name, version, and README.
- An extension package has an `index.ts` entry point declared in `pi.extensions` and can contain `tests/`.
- Companion skills belong in that package's `skills/<skill-name>/SKILL.md` directories and are declared through `pi.skills`. They ship with the extension, not as mandatory separate packages.
- A skills-only package uses the same package directory structure but has no extension entry point. It can contain one or multiple skills.
- Packages must be independently installable through `pi install npm:<package-name>`. Declare and include runtime files within the package; do not rely on unpublished sibling files.

## Scope boundaries

- The examples in `docs/PACKAGES.md` illustrate supported package types, not packages to create automatically.
- Implement only explicitly requested packages and behavior. The Apple Mail conversion is separate work in `task-316b8934`.
- Do not introduce templates, CI, linting, test frameworks, dependencies, build tooling, or other scaffolding unless separately approved.
- Do not publish npm packages or modify the user's Pi installation without explicit authorization.
