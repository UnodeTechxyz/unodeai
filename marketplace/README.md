# UnodeAi Marketplace catalog

Curated, in-repo catalog the Marketplace browses (M0 contract). Three files, each a **JSON array**
of entries. Schema + validation: [`src/marketplace/catalog.ts`](../src/marketplace/catalog.ts).
Design: [`docs/V0.6.0_MARKETPLACE_AND_HEADER_IA.md`](../docs/V0.6.0_MARKETPLACE_AND_HEADER_IA.md).

> **Validation is enforced.** `npm test` parses these files through `catalog.ts`; a malformed entry
> fails the build with the exact path + reason. Author against the fields below — don't guess.

Role Templates and *Create a team* are projected from the same `ROLE_TEMPLATES` catalog. Adding a Role
Template creates an Agent in a team; suggested integrations are display-only and never configure, approve,
mount, or grant an MCP server. Per-agent grants remain explicit and default-deny.

---

## `agents.json` — retired compatibility input

The former 13-entry file remains only so the reconciliation test can prove every old listing maps to a current
role-template key. It is not a second runtime role catalog. New roles belong in `ROLE_TEMPLATES`.

| field | required | notes |
|---|---|---|
| `id` | ✅ | unique kebab-case |
| `name` | ✅ | display name |
| `role` | ✅ | a known `AgentRole` |
| `summary` | ✅ | one line for the card |
| `skills` | ✅ | array of skill ids from `SKILL_LIBRARY` (see `src/roles/RoleConfig.ts`) |
| `model` | ✅ | Claude model id (used on the claude backend) |
| `tier` | ✅ | `premium` \| `standard` \| `economy` |
| `systemPrompt` | ✅ | the agent's persona/instructions |
| `roleTemplateKey` | ✅ | exact key in `ROLE_TEMPLATES` |
| `suggestedMcpServers` | ➖ | display-only integration suggestions; never grants |
| `icon` `color` `modelParams` | ➖ | optional |

```json
{
  "id": "security",
  "roleTemplateKey": "security",
  "name": "Security Auditor",
  "role": "security",
  "summary": "SAST review + secret scanning + dependency-risk triage.",
  "icon": "🛡",
  "skills": ["security-audit", "code-review"],
  "model": "claude-sonnet-4-20250514",
  "tier": "standard",
  "systemPrompt": "You are a security auditor. Find vulnerabilities, never introduce them..."
}
```

## `mcp.json` — `McpCatalogEntry[]`

This is the active governed Integration catalog. Adding an entry writes configuration and then uses the
existing approval/mount gate; it does not grant the integration to an Agent. **Never put real secrets in
`env`**—use `${VAR}` placeholders. The entry does not carry an approval flag: the host derives one answer from
the actual subprocess, endpoint, and credential configuration for both display and enforcement.

| field | required | notes |
|---|---|---|
| `id` `name` `summary` | ✅ | |
| `transport` | ✅ | `stdio` \| `streamable-http` \| `sse` |
| `command` | for `stdio` | e.g. `npx` |
| `url` | for remote | fixed http/sse endpoint |
| `urlPrompt` | for remote | ask the user for an endpoint during install when the URL is local/user-specific |
| `args` `env` `icon` | ➖ | credential names/placeholders only; never values |
| `source` | ✅ | authoritative HTTPS source for provenance; archived sources are rejected |
| `maintenanceState` | ✅ | `reference` \| `maintained` \| `community` |
| `lastVerified` | ✅ | ISO date, not future and no more than 180 days old |
| `installIdentity` | ✅ | exact `npm`, `pypi`, `docker`, or `endpoint` identity matching the launch config |
| `deprecated` | forbidden | deprecated entries are not installable and cannot appear in the active schema |

```json
{
  "id": "filesystem",
  "name": "Filesystem",
  "summary": "Read/write files under an allowed root.",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "${WORKSPACE}"],
  "source": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  "maintenanceState": "reference",
  "lastVerified": "2026-09-11",
  "installIdentity": { "ecosystem": "npm", "value": "@modelcontextprotocol/server-filesystem" }
}
```

Use `urlPrompt` instead of `url` where UnodeAi cannot know a local endpoint ahead of time. Such an entry still
needs an authoritative source and a stable endpoint identity; unsourced local bridges are not active catalog
recommendations.

```json
{
  "id": "hermes-bridge",
  "name": "Hermes Bridge",
  "summary": "Connect a local Hermes-compatible MCP bridge.",
  "transport": "streamable-http",
  "urlPrompt": {
    "title": "Hermes Bridge MCP URL",
    "prompt": "Enter the streamable HTTP MCP endpoint exposed by your Hermes bridge.",
    "placeHolder": "http://127.0.0.1:8765/mcp"
  },
  "source": "https://example.com/hermes-mcp",
  "maintenanceState": "community",
  "lastVerified": "2026-09-11",
  "installIdentity": { "ecosystem": "endpoint", "value": "https://example.com/hermes-mcp" }
}
```

The Marketplace shows `listed`, `configured`, `approved`, `mounted`, `exercised`, and `succeeded` separately.
**Check setup** reports those host facts only and grants nothing.

## `skills.json` — `SkillCatalogEntry[]`
Installs a skill package. `body` is inline SKILL.md (loaded on-demand in Phase 3).

| field | required | notes |
|---|---|---|
| `id` `name` `summary` | ✅ | |
| `category` | ✅ | a known `SkillCategory` (`development`, `security`, `external`, …) |
| `capabilities` | ✅ | builtin tool tokens granted (`read`,`write`,`search`,`execute`) |
| `body` | ➖ | inline SKILL.md markdown |

```json
{
  "id": "api-contract-review",
  "name": "API Contract Review",
  "summary": "Check API changes for backward compatibility and versioning.",
  "category": "development",
  "capabilities": ["read", "search"],
  "body": "# API Contract Review\n\nWhen reviewing an API change..."
}
```
