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

Publication requires npm authentication and permission for the chosen name/scope. Never commit credentials. Do not use blanket `npm publish --workspaces` or publish the repository root. The generic commands above are not the Apple Mail release path; use its scoped automation below.

### Apple Mail: GitHub Actions and npm trusted publishing

`.github/workflows/release.yml` releases only `@evcraddock/pi-apple-mail` from `packages/apple-mail/`. It follows the OIDC approach in `todu-pi-extensions`, not Slugkit's token authentication. The workflow does not install dependencies, build TypeScript, publish the workspace root, publish Migadu, or create GitHub Releases. Apple Mail's runtime remains self-contained and its version remains independent.

The publisher is the existing GitHub repository `evcraddock/workbench`, using GitHub-hosted runners. Forgejo and self-hosted runners are not supported by npm trusted publishing. No repository creation or mirroring is needed. Public repository visibility is authorized for this task, but check the repository contents and history for sensitive material before changing it. OIDC also works from a private repository; automatic npm provenance requires both the source repository and npm package to be public. The Apple Mail manifest's `repository.url` must match `git+https://github.com/evcraddock/workbench.git`, with `repository.directory` set to `packages/apple-mail`.

#### One-time npm setup and first-publication gate

The package must exist before its npm package settings can be used to register a trusted publisher. If it is absent, stop before triggering a release and obtain explicit approval for the one-time reservation/bootstrap. Do not silently use a publishing token or manually publish the intended release version as a workaround.

npm's documented [staged publishing](https://docs.npmjs.com/staged-publishing/) flow can reserve a new name: with npm CLI 11.15.0+ and an interactive npm sign-in for an account with publish access and 2FA enabled, stage a reviewed bootstrap candidate for exactly `@evcraddock/pi-apple-mail` at a distinct version such as `0.0.0-bootstrap`. Do this outside the tracked checkout so the release manifest remains unchanged. Staging a previously absent package creates a **public `0.0.0-stage` placeholder**; the candidate's contents stay unpublished unless approved. This reservation is an explicit one-time interactive step, not an OIDC release. Leave the bootstrap candidate unapproved; do not use `0.1.0` (or another intended release version) for it. Confirm ownership and package-settings availability before proceeding. If npm does not permit this setup, report the blocker rather than falling back to a token or manual release. The real package version must be published by the OIDC workflow.

After the workflow is reviewed and merged, configure the package's **Settings → Trusted publishing** on npmjs.com using [npm's trusted-publisher instructions](https://docs.npmjs.com/trusted-publishers/):

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `evcraddock` |
| Repository | `workbench` |
| Workflow filename | `release.yml` (filename only) |
| Environment | Unset; the workflow does not use a GitHub environment |
| Allowed actions | Allow direct `npm publish`; dist-tag management is not needed |

New trusted-publisher configurations must complete their first successful publication within two days. Configure this close to the approved release; an expired configuration must be deleted and recreated. The workflow uses Node 24 and checks npm is at least 11.5.1 for OIDC. Only the publication job receives `id-token: write`; pull-request verification has read-only repository permissions. Do not configure `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or a long-lived npm publishing secret. After successful OIDC verification, consider npm's recommended “Require two-factor authentication and disallow tokens” setting as a separately approved security change.

#### Prepare, review and release only Apple Mail

1. For a subsequent release, bump only Apple Mail's version with `npm version patch --workspace @evcraddock/pi-apple-mail --no-git-tag-version` (or the agreed semantic increment). The initial release uses its existing `0.1.0`; do not bump just to publish it. This workflow currently accepts stable versions only.
2. On a task branch, run `npm test --workspace @evcraddock/pi-apple-mail` and `npm pack --workspace @evcraddock/pi-apple-mail --dry-run --json`. The release-only `packages/apple-mail/scripts/release-check.mjs` validates metadata and an optional npm pack JSON report; its built-in-runner tests cover tag/version mismatches, wrong workspaces, root privacy, repository metadata, and missing/extra tarball files. No test framework or dependency installation is needed.
3. Open a PR and obtain independent review and explicit human merge approval. The workflow verifies relevant PRs, using simulated Mail objects only; it never accesses a real mailbox. Merge before creating a release tag.
4. Confirm npm bootstrap/trusted-publisher setup and obtain explicit publication approval. A matching tag push **automatically publishes**; do not push it merely to test CI. Create the package-specific tag at the reviewed main commit, matching the manifest exactly, for example:

```bash
git tag apple-mail-v0.1.0 <reviewed-main-commit>
git push origin refs/tags/apple-mail-v0.1.0
```

The workflow rejects mismatched tags and release commits that are not ancestors of `origin/main`. It tests only Apple Mail, creates one workspace tarball, verifies its exact seven-file allowlist (entry point, runtime sources, JXA script, skill, README and manifest), and uploads that tarball. The release helper and tests are not shipped. The publication job downloads and verifies the tarball's SHA-512 integrity, then publishes that same tarball to npm with OIDC, without repacking. Public repositories receive npm's automatic provenance; no `--provenance` flag is required.

For an authorized manual dispatch, select the **existing release tag** as the workflow ref, not `main`, so the run's OIDC/provenance revision matches the released source:

```bash
gh workflow run release.yml --repo evcraddock/workbench --ref apple-mail-v0.1.0
```

Do not dispatch blindly after a failed or uncertain publication. The workflow never retries the publish write or treats an “already published” error as success; first inspect npm and the run logs. Registry verification retries only reads and compares the published name, version and `dist.integrity` to the verified tarball. If publication succeeded but verification failed, verify the existing version rather than trying to overwrite it. A changed tarball requires a new reviewed package version and tag.

Finally, verify registry metadata with `npm view @evcraddock/pi-apple-mail@0.1.0 name version dist.integrity --json --registry https://registry.npmjs.org` (substitute the released version), and inspect provenance when the source repository is public. Report the actual release outcome; passing PR checks alone does not establish publication. Installation or live Mail testing remains a separate user-authorized action.

## Installation

Once a real package is published, install only that package:

```bash
pi install npm:@your-scope/pi-example-extension
# Or pin a published version:
pi install npm:@your-scope/pi-example-extension@0.1.0
```

The same syntax applies to skills-only and combined packages. Restart Pi or use `/reload` to load newly installed resources. Package-local Pi declarations expose only that package's extension and/or skills, not all workbench packages.
