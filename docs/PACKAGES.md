# Workbench packages

Workbench uses a private npm workspace root, with one independently versioned and published npm package per directory under `packages/`. A package can contain an extension, skills only, or an extension with companion skills.

## Complete structure

```text
workbench/
├── AGENTS.md                         # instructions for future agents
├── package.json                      # private npm workspace root
├── packages/
│   │
│   ├── apple-mail/                    # extension WITH companion skills
│   │   ├── package.json              # independently versioned/published
│   │   ├── index.ts                  # extension entry point
│   │   ├── README.md
│   │   ├── tests/
│   │   └── skills/
│   │       └── apple-mail/
│   │           └── SKILL.md
│   │
│   ├── <extension-only-package>/     # extension WITHOUT skills
│   │   ├── package.json              # independently versioned/published
│   │   ├── index.ts
│   │   ├── README.md
│   │   └── tests/
│   │
│   └── <skills-only-package>/        # skills WITHOUT an extension
│       ├── package.json              # independently versioned/published
│       ├── README.md
│       └── skills/
│           ├── <skill-one>/
│           │   └── SKILL.md
│           └── <skill-two>/
│               └── SKILL.md
│
└── docs/
    └── PACKAGES.md                   # this guide
```

The package directories above illustrate the supported shapes; they are not packages implemented by this setup. Angle-bracket names are placeholders. Apple Mail implementation remains separate in `task-316b8934`.

The initial repository contains only the private root manifest, `packages/.gitkeep`, this guide, and `AGENTS.md`. No templates, CI, linting, test frameworks, dependencies, or build tooling are configured.

## Package manifests

Choose an available npm name or authorized scope for each real package. Names below are examples, not reserved names or a selected workbench scope. Each package owns its version independently. The examples explicitly use public npm access; review that setting before publishing.

### Extension only

```json
{
  "name": "@your-scope/pi-example-extension",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "files": ["index.ts"],
  "publishConfig": { "access": "public" },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

The entry point exports Pi's default extension factory. Pi loads TypeScript directly; this layout does not require a compilation step. The package's `tests/` directory is for its own tests when implemented; this setup does not select or install a test framework.

### Skills only

```json
{
  "name": "@your-scope/pi-example-skills",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "files": ["skills/"],
  "publishConfig": { "access": "public" },
  "pi": {
    "skills": ["./skills"]
  }
}
```

No `index.ts` or `pi.extensions` declaration is required. One package may include multiple `skills/<skill-name>/SKILL.md` directories. Each `SKILL.md` needs frontmatter with a skill name and description followed by its instructions. Include any scripts, references, or assets used by the skill within the package as well.

### Extension with companion skills

```json
{
  "name": "@your-scope/pi-example-combined",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "files": ["index.ts", "skills/"],
  "publishConfig": { "access": "public" },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"]
  }
}
```

Installing this package makes both its extension and its companion skills available. The skills do not need their own npm packages.

## Published files and runtime boundaries

- Keep the root private. Publish only explicitly selected packages under `packages/`.
- Use each package's `files` allowlist to include all declared Pi resources and runtime helpers/assets. Expand the examples when adding directories such as `src/` or `resources/`. npm includes `package.json`, README, and LICENSE automatically when present.
- Keep Pi manifest paths relative to that package's root. Resolve bundled assets relative to the module or skill directory, not the repository root or current working directory.
- Do not import unpublished files from sibling packages. A standalone installation does not include the rest of workbench.
- Put third-party runtime libraries in that package's `dependencies`. Pi-provided modules belong in `peerDependencies` with a `"*"` range, not bundled runtime dependencies. These are `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and `typebox`; declare only those actually used. Pi suppresses automatic host peer installation for its managed packages.

## Independent versioning and publication

The following commands are guidance for future real packages, not authorization to publish anything now. Replace the illustrative package name with the selected workspace's actual npm name.

Inspect only the package being released:

```bash
npm pack --workspace @your-scope/pi-example-extension --dry-run
```

Confirm its entry point, skills, and runtime resources are included and that unrelated packages, tests, and secrets are absent.

Bump only that package's version using the appropriate semantic-version increment:

```bash
npm version patch --workspace @your-scope/pi-example-extension --no-git-tag-version
```

Review the manifest and any generated lockfile changes. This does not create an automatic git version commit/tag. Do not synchronize unrelated package versions.

After the release changes have been reviewed and publication explicitly authorized, publish that one package:

```bash
npm publish --workspace @your-scope/pi-example-extension
```

Publication requires npm authentication and permission for the chosen name/scope. Never commit credentials. Do not use blanket `npm publish --workspaces` or publish the repository root. This setup does not configure automatic releases.

## Installation

Once a real package is published, install only that package:

```bash
pi install npm:@your-scope/pi-example-extension
# Or pin a published version:
pi install npm:@your-scope/pi-example-extension@0.1.0
```

The same syntax applies to skills-only and combined packages. Restart Pi or use `/reload` to load newly installed resources. Package-local Pi declarations expose only that package's extension and/or skills, not all workbench packages.
