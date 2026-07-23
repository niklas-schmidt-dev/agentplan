# Agent setup for `agentplan`

Project context is complete. The target is the immutable audit snapshot at
`../../.audit-work/snapshot`.

Before changing scan configuration, read:

1. `node_modules/deepsec/SKILL.md`
2. `node_modules/deepsec/dist/docs/getting-started.md`
3. `node_modules/deepsec/dist/docs/configuration.md`
4. `node_modules/deepsec/dist/docs/writing-matchers.md`

Keep `INFO.md` concise and project-specific. Add custom matchers only after the
built-in scan demonstrates an entry-point coverage gap or a revalidated finding
needs sibling detection.
