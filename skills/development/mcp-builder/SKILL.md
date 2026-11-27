---
name: mcp-builder
description: Use when building or improving an MCP (Model Context Protocol) server that lets a model work with an external API or service, in TypeScript (MCP SDK) or Python (FastMCP). Covers tool design, schemas, errors, pagination, local testing (initialize, list tools, call, error) and evaluation questions run by the current agent.
---

# MCP Server Development Guide

## Overview

Create MCP (Model Context Protocol) servers that enable models to interact with external services through
well-designed tools. The quality of an MCP server is measured by how well it enables models to accomplish real-world
tasks.

Reference files in this skill are read with `read_skill_file` where that tool is offered, otherwise from this
skill's `reference/` folder. Load only the ones you need.

---

# Process

## High-Level Workflow

Creating a high-quality MCP server involves four main phases.

### Phase 1: Deep Research and Planning

#### 1.1 Understand Modern MCP Design

**API Coverage vs. Workflow Tools:**
Balance comprehensive API endpoint coverage with specialized workflow tools. Workflow tools can be more convenient
for specific tasks, while comprehensive coverage gives agents flexibility to compose operations. Performance varies by
client: some clients benefit from code execution that combines basic tools, while others work better with
higher-level workflows. When uncertain, prioritize comprehensive API coverage.

**Tool Naming and Discoverability:**
Clear, descriptive tool names help agents find the right tools quickly. Use consistent prefixes (e.g.,
`github_create_issue`, `github_list_repos`) and action-oriented naming.

**Context Management:**
Agents benefit from concise tool descriptions and the ability to filter/paginate results. Design tools that return
focused, relevant data. Some clients support code execution which can help agents filter and process data
efficiently.

**Actionable Error Messages:**
Error messages should guide agents toward solutions with specific suggestions and next steps.

#### 1.2 Study MCP Protocol Documentation

**Navigate the MCP specification** with your web-fetch tool, if you have one:

Start with the sitemap to find relevant pages: `https://modelcontextprotocol.io/sitemap.xml`

Then fetch specific pages with `.md` suffix for markdown format (e.g.,
`https://modelcontextprotocol.io/specification/draft.md`).

Key pages to review:
- Specification overview and architecture
- Transport mechanisms (streamable HTTP, stdio)
- Tool, resource, and prompt definitions

#### 1.3 Study Framework Documentation

**Recommended stack:**
- **Language**: TypeScript (high-quality SDK support and good compatibility in many execution environments, plus
  static typing and good linting tools). Where the project already uses Python or another stack, follow the project.
- **Transport**: Streamable HTTP for remote servers, using stateless JSON (simpler to scale and maintain, as opposed
  to stateful sessions and streaming responses). stdio for local servers.

**Load framework documentation:**

- **MCP Best Practices**: `reference/mcp_best_practices.md` - Core guidelines

**For TypeScript:**

The TypeScript SDK has two major versions. Use the one the project already uses:
- **v2** (`@modelcontextprotocol/server`): the current stable release. Use it for new servers.
- **v1** (`@modelcontextprotocol/sdk`): receives bug and security fixes only. Use it when the project's
  `package.json` already depends on `@modelcontextprotocol/sdk`.

If the project already uses v1, tell the user once, in a sentence or two, that v2 (`@modelcontextprotocol/server`)
is the current stable release, that v1 receives only bug and security fixes, and that the official codemod migrates
a project (see "Migrating a v1 Server" in `reference/node_mcp_server_v2.md`). Then continue with v1. Migrate only when
the user asks for it.

Don't mix the two in one project: v1 code samples (imports from `@modelcontextprotocol/sdk/...`) don't apply to v2.

- **TypeScript SDK (v2)**: `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md`; the
  full docs index is `https://ts.sdk.modelcontextprotocol.io/v2/llms.txt`
- `reference/node_mcp_server_v2.md` - TypeScript patterns and examples (SDK v2)
- For v1 projects only: `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md` and
  `reference/node_mcp_server.md`

**For Python:**
- **Python SDK**: `https://raw.githubusercontent.com/modelcontextprotocol/python-sdk/main/README.md`
- `reference/python_mcp_server.md` - Python patterns and examples

#### 1.4 Plan Your Implementation

**Understand the API:**
Review the service's API documentation to identify key endpoints, authentication requirements, and data models. Use
web search and web fetch as needed.

**Tool Selection:**
Prioritize comprehensive API coverage. List endpoints to implement, starting with the most common operations.

---

### Phase 2: Implementation

#### 2.1 Set Up Project Structure

See the language-specific guides for project setup:
- `reference/node_mcp_server_v2.md` - Project structure, package.json, tsconfig.json (`reference/node_mcp_server.md`
  for existing v1 projects)
- `reference/python_mcp_server.md` - Module organization, dependencies

Pin the SDK version the project uses; do not move an existing project to another SDK major version on your own.

#### 2.2 Implement Core Infrastructure

Create shared utilities:
- API client with authentication
- Error handling helpers
- Response formatting (JSON/Markdown)
- Pagination support

#### 2.3 Implement Tools

For each tool:

**Input Schema:**
- Use Zod (TypeScript) or Pydantic (Python)
- Include constraints and clear descriptions
- Add examples in field descriptions

**Output Schema:**
- Define `outputSchema` where possible for structured data
- Use `structuredContent` in tool responses (TypeScript SDK feature)
- Helps clients understand and process tool outputs

**Tool Description:**
- Concise summary of functionality
- Parameter descriptions
- Return type schema

**Implementation:**
- Async/await for I/O operations
- Proper error handling with actionable messages
- Support pagination where applicable
- Return both text content and structured data when using modern SDKs

**Annotations:**
- `readOnlyHint`: true/false
- `destructiveHint`: true/false
- `idempotentHint`: true/false
- `openWorldHint`: true/false

---

### Phase 3: Review and Test

#### 3.1 Code Quality

Review for:
- No duplicated code (DRY principle)
- Consistent error handling
- Full type coverage
- Clear tool descriptions

#### 3.2 Build and Test

Prove four things on a local server: it initializes, it lists its tools, a valid call returns the expected result,
and an invalid call returns an error the model can read.

**TypeScript:**
- Run `npm run build` to verify compilation
- v2 projects: run the self-check script from "Verify Your Server" in `reference/node_mcp_server_v2.md` against the
  built server
- Or use the connection helper below

**Python:**
- Verify syntax: `python -m py_compile your_server.py`
- Use the connection helper below

**The connection helper** (`reference/connection-helper.md`) initializes a server, lists its tools and calls one tool
per command, with no model and no API key. Write it into the workspace when you want it, and run it with your normal
command permission.

**MCP Inspector** (`@modelcontextprotocol/inspector`) is an interactive UI for manual exploration. It is optional; see
"Missing tools" below before using it.

Do not add the server you build to the user's integrations or to any CLI configuration. Registering or granting it is
the user's choice.

See the language-specific guides for detailed testing approaches and quality checklists.

---

### Phase 4: Create Evaluations

After implementing your MCP server, create evaluations to test how well a model can use it.

**Read `reference/evaluation.md` for the complete evaluation guidelines.**

#### 4.1 Understand Evaluation Purpose

Use evaluations to test whether models can effectively use your MCP server to answer realistic, complex questions.

#### 4.2 Create 10 Evaluation Questions

Follow the process in the evaluation guide:

1. **Tool Inspection**: List available tools and understand their capabilities
2. **Content Exploration**: Use READ-ONLY operations to explore available data
3. **Question Generation**: Create 10 complex, realistic questions
4. **Answer Verification**: Solve each question yourself to verify answers

#### 4.3 Evaluation Requirements

Ensure each question is:
- **Independent**: Not dependent on other questions
- **Read-only**: Only non-destructive operations required
- **Complex**: Requiring multiple tool calls and deep exploration
- **Realistic**: Based on real use cases humans would care about
- **Verifiable**: Single, clear answer that can be verified by string comparison
- **Stable**: Answer won't change over time

#### 4.4 Output Format

Create an XML file with this structure:

```xml
<evaluation>
  <qa_pair>
    <question>Find discussions about AI model launches with animal codenames. One model needed a specific safety designation that uses the format ASL-X. What number X was being determined for the model named after a spotted wild cat?</question>
    <answer>3</answer>
  </qa_pair>
<!-- More qa_pairs... -->
</evaluation>
```

#### 4.5 Run the Evaluation Yourself

You run the questions with the model, budget and tools you already have, through the server's tools (granted to you,
or through the connection helper), and record each result in the report format in `reference/evaluation.md`. Do not
create a model API client, read an API key from the environment or a credentials file, ask the user to paste a key,
or start a separate evaluation pipeline. If you cannot reach the server's tools, keep the questions and report the
evaluation as not run.

---

# Missing tools

Go through these in order.

1. **Use what is already there.** The MCP SDK, test client or Inspector the project already declares, run from the
   project (`npm run ...`, `npx` of a declared package, the project's virtual environment). This starts no new
   download.
2. **Install inside the project when the task needs it.** Building the server includes installing what the build and
   its tests need inside the project: the SDK and a test client as dependencies or dev dependencies, or the `mcp`
   package in a project virtual environment. Pin exact versions and tell the user what you added.
3. **Ask once before a download outside the project.** `npx` of a package the project does not declare (for example
   `npx @modelcontextprotocol/inspector` or the migration codemod) downloads it into the npm cache outside the
   project; a global `npm` or `pip` install changes the machine. Before it, ask once and name the exact command with a
   pinned version (not `@latest`), where it goes and its approximate size (say it is unknown if you cannot tell). The
   alternative is a pinned dev dependency (step 2). If the user declines, or you have no way to ask, report the
   missing tool and the exact command, and continue with what does not need it.

---

# Reference Files

## Documentation Library

Load these resources as needed during development:

### Core MCP Documentation (Load First)
- **MCP Protocol**: Start with the sitemap at `https://modelcontextprotocol.io/sitemap.xml`, then fetch specific
  pages with `.md` suffix
- `reference/mcp_best_practices.md` - Universal MCP guidelines including:
  - Server and tool naming conventions
  - Response format guidelines (JSON vs Markdown)
  - Pagination best practices
  - Transport selection (streamable HTTP vs stdio)
  - Security and error handling standards

### SDK Documentation (Load During Phase 1/2)
- **Python SDK**: `https://raw.githubusercontent.com/modelcontextprotocol/python-sdk/main/README.md`
- **TypeScript SDK (v2)**: `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md`;
  full docs index at `https://ts.sdk.modelcontextprotocol.io/v2/llms.txt`
- **TypeScript SDK (v1, existing v1 projects only)**:
  `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md`

### Language-Specific Implementation Guides (Load During Phase 2)
- `reference/python_mcp_server.md` - Complete Python/FastMCP guide with:
  - Server initialization patterns
  - Pydantic model examples
  - Tool registration with `@mcp.tool`
  - Complete working examples
  - Quality checklist

- `reference/node_mcp_server_v2.md` - Complete TypeScript guide for `@modelcontextprotocol/server` with:
  - Project setup and the server factory
  - Tool design: Zod 4 schemas, output formats, pagination, errors
  - A complete example serving stdio and Streamable HTTP, plus bearer auth
  - Resources, prompts, and notifications
  - A self-check script to verify the built server
  - Links to SDK examples for advanced features
  - A v1 → v2 translation table, migration steps, and a quality checklist

- `reference/node_mcp_server.md` - The equivalent guide for existing `@modelcontextprotocol/sdk` projects

### Testing and Evaluation (Load During Phase 3/4)
- `reference/connection-helper.md` - Initialize a server, list its tools, call a tool; no model, no API key
- `reference/evaluation.md` - Evaluation creation guide with:
  - Question creation guidelines
  - Answer verification strategies
  - XML format specifications
  - Example questions and answers
  - How the current agent runs an evaluation and records the report
- `reference/example-evaluation.md` - A small example evaluation file (format only)

---
Adapted from the Apache-2.0 `mcp-builder` skill in github.com/anthropics/skills. What changed and why is listed in
`SOURCE.md`; the license is in `LICENSE.txt`.
