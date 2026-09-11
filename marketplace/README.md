# UnodeAi Marketplace catalog

Curated, in-repo catalog the Marketplace browses (M0 contract). Three files, each a **JSON array**
of entries. Schema + validation: [`src/marketplace/catalog.ts`](../src/marketplace/catalog.ts).
Design: [`docs/V0.6.0_MARKETPLACE_AND_HEADER_IA.md`](../docs/V0.6.0_MARKETPLACE_AND_HEADER_IA.md).

> **Validation is enforced.** `npm test` parses these files through `catalog.ts`; a malformed entry
> fails the build with the exact path + reason. Author against the fields below — don't guess.

Browsed globally; **applied at a scope chosen on install** (`MarketplaceInstallAction`):
Agents → a team · MCP → extension-wide or a team · Skills → global (`~/.unode/skills`) or project.

---

## `agents.json` — `AgentCatalogEntry[]`
An agent preset = a `RoleTemplate` as data. Installing one mints an `AgentConfig` into a team.

| field | required | notes |
|---|---|---|
| `id` | ✅ | unique kebab-case |
| `name` | ✅ | display name |
| `role` | ✅ | a known `AgentRole` (not `solo`/`custom`) — e.g. `developer`, `security`, `product-manager` |
| `summary` | ✅ | one line for the card |
| `skills` | ✅ | array of skill ids from `SKILL_LIBRARY` (see `src/roles/RoleConfig.ts`) |
| `model` | ✅ | Claude model id (used on the claude backend) |
| `tier` | ✅ | `premium` \| `standard` \| `economy` |
| `systemPrompt` | ✅ | the agent's persona/instructions |
| `icon` `color` `modelParams` | ➖ | optional |

```json
{
  "id": "security-auditor",
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
Maps to `MCPServerConfig` + card metadata. Installing generates the config and routes it through
the existing approval gate. **Never put real secrets in `env`** — use `${VAR}` placeholders.

| field | required | notes |
|---|---|---|
| `id` `name` `summary` | ✅ | |
| `transport` | ✅ | `stdio` \| `streamable-http` \| `sse` |
| `command` | for `stdio` | e.g. `npx` |
| `url` | for remote | fixed http/sse endpoint |
| `urlPrompt` | for remote | ask the user for an endpoint during install when the URL is local/user-specific |
| `args` `env` `requiresApproval` `icon` | ➖ | |
| `source` | ➖ (recommended) | homepage/docs URL for provenance |

```json
{
  "id": "filesystem",
  "name": "Filesystem",
  "summary": "Read/write files under an allowed root.",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "${WORKSPACE}"],
  "requiresApproval": true,
  "source": "https://github.com/modelcontextprotocol/servers"
}
```

Use `urlPrompt` instead of `url` for bridge-style integrations where UnodeAi cannot know the
user's local endpoint ahead of time:

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
  "requiresApproval": true
}
```

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
