> Adapted from the upstream `mcp-builder` skill (Apache-2.0); the changes are listed in `SOURCE.md`.

# Helper: connect to an MCP server, list its tools, call a tool

Upstream shipped `scripts/connections.py` as the connection layer of its evaluation runner. Skill folders here carry
no scripts, so it is reference text, with a small command line added. When you want it, write the code below into the
workspace yourself, for example as `.skill-helpers/mcp_probe.py`, and run it with your normal command permission.
Tell the user where you wrote it, and remove it when the task is done unless they want to keep it.

It proves the four things a local server must do: initialize, list its tools, answer a valid call, and return a
readable error for an invalid one. It calls no model and needs no API key.

## What it needs

Python 3.10 or later and the MCP Python SDK (`mcp`). Use them in this order:
1. The project's own virtual environment, if it already has `mcp`.
2. Otherwise install it into a project virtual environment: `python -m venv .venv`, then
   `.venv\Scripts\python -m pip install mcp==<version>` on Windows or `.venv/bin/python -m pip install
   mcp==<version>` elsewhere. Pin an exact version and tell the user what you added.
3. A global `pip install` is a machine-wide install: ask once first, naming the exact command and where it installs.

For a TypeScript server built with SDK v2, the self-check script in `node_mcp_server_v2.md` ("Verify Your Server")
does the same from Node with the project's own dev dependency, and may be the simpler choice.

## Usage

Run from the project folder (use `py -3` or `.venv\Scripts\python` as fits the machine):

```text
python .skill-helpers/mcp_probe.py list -- node dist/index.js
python .skill-helpers/mcp_probe.py call example_search_users "{\"query\": \"john\", \"limit\": 5}" -- node dist/index.js
python .skill-helpers/mcp_probe.py call example_search_users "{\"query\": \"j\"}" -- node dist/index.js
python .skill-helpers/mcp_probe.py list -t http -u http://127.0.0.1:3000/mcp
```

Options go before `--`; everything after `--` is the command that starts a stdio server.
`list` prints each tool's name, description and input schema. `call` prints `isError`, the content and any
structured content, and exits with status 1 when the tool reported an error. Each command starts a stdio server
afresh and stops it when the command ends; an HTTP or SSE server must already be running.

Pass with `-e` only what the server itself needs. If it needs a credential for its own service, use the one the user
configured for it; do not search files or the environment for one, and do not print it.

## Code

`connections.py` as upstream wrote it, followed by the added command line.

```python
"""Lightweight connection handling for MCP servers."""

from abc import ABC, abstractmethod
from contextlib import AsyncExitStack
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client


class MCPConnection(ABC):
    """Base class for MCP server connections."""

    def __init__(self):
        self.session = None
        self._stack = None

    @abstractmethod
    def _create_context(self):
        """Create the connection context based on connection type."""

    async def __aenter__(self):
        """Initialize MCP server connection."""
        self._stack = AsyncExitStack()
        await self._stack.__aenter__()

        try:
            ctx = self._create_context()
            result = await self._stack.enter_async_context(ctx)

            if len(result) == 2:
                read, write = result
            elif len(result) == 3:
                read, write, _ = result
            else:
                raise ValueError(f"Unexpected context result: {result}")

            session_ctx = ClientSession(read, write)
            self.session = await self._stack.enter_async_context(session_ctx)
            await self.session.initialize()
            return self
        except BaseException:
            await self._stack.__aexit__(None, None, None)
            raise

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Clean up MCP server connection resources."""
        if self._stack:
            await self._stack.__aexit__(exc_type, exc_val, exc_tb)
        self.session = None
        self._stack = None

    async def list_tools(self) -> list[dict[str, Any]]:
        """Retrieve available tools from the MCP server."""
        response = await self.session.list_tools()
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.inputSchema,
            }
            for tool in response.tools
        ]

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        """Call a tool on the MCP server with provided arguments."""
        result = await self.session.call_tool(tool_name, arguments=arguments)
        return result.content


class MCPConnectionStdio(MCPConnection):
    """MCP connection using standard input/output."""

    def __init__(self, command: str, args: list[str] = None, env: dict[str, str] = None):
        super().__init__()
        self.command = command
        self.args = args or []
        self.env = env

    def _create_context(self):
        return stdio_client(
            StdioServerParameters(command=self.command, args=self.args, env=self.env)
        )


class MCPConnectionSSE(MCPConnection):
    """MCP connection using Server-Sent Events."""

    def __init__(self, url: str, headers: dict[str, str] = None):
        super().__init__()
        self.url = url
        self.headers = headers or {}

    def _create_context(self):
        return sse_client(url=self.url, headers=self.headers)


class MCPConnectionHTTP(MCPConnection):
    """MCP connection using Streamable HTTP."""

    def __init__(self, url: str, headers: dict[str, str] = None):
        super().__init__()
        self.url = url
        self.headers = headers or {}

    def _create_context(self):
        return streamablehttp_client(url=self.url, headers=self.headers)


def create_connection(
    transport: str,
    command: str = None,
    args: list[str] = None,
    env: dict[str, str] = None,
    url: str = None,
    headers: dict[str, str] = None,
) -> MCPConnection:
    """Factory function to create the appropriate MCP connection.

    Args:
        transport: Connection type ("stdio", "sse", or "http")
        command: Command to run (stdio only)
        args: Command arguments (stdio only)
        env: Environment variables (stdio only)
        url: Server URL (sse and http only)
        headers: HTTP headers (sse and http only)

    Returns:
        MCPConnection instance
    """
    transport = transport.lower()

    if transport == "stdio":
        if not command:
            raise ValueError("Command is required for stdio transport")
        return MCPConnectionStdio(command=command, args=args, env=env)

    elif transport == "sse":
        if not url:
            raise ValueError("URL is required for sse transport")
        return MCPConnectionSSE(url=url, headers=headers)

    elif transport in ["http", "streamable_http", "streamable-http"]:
        if not url:
            raise ValueError("URL is required for http transport")
        return MCPConnectionHTTP(url=url, headers=headers)

    else:
        raise ValueError(f"Unsupported transport type: {transport}. Use 'stdio', 'sse', or 'http'")

# ---------------------------------------------------------------------------
# Adapted: a small command line around the classes above, so the current agent can initialize a server, list its
# tools and call one tool per command. It replaces the upstream evaluation runner's connection use; it calls no
# model and reads no API key.
# ---------------------------------------------------------------------------

import argparse
import asyncio
import json
import sys


def _parse_pairs(values, separator, label):
    pairs = {}
    for value in values or []:
        if separator not in value:
            print(f"Warning: ignoring malformed {label}: {value}", file=sys.stderr)
            continue
        key, item = value.split(separator, 1)
        pairs[key.strip()] = item.strip()
    return pairs


def _dump(value):
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True)
    return value


async def _run(args) -> int:
    server = args.server
    connection = create_connection(
        transport=args.transport,
        command=server[0] if server else None,
        args=server[1:],
        env=_parse_pairs(args.env, "=", "environment variable") or None,
        url=args.url,
        headers=_parse_pairs(args.header, ":", "header") or None,
    )
    async with connection:
        if args.action == "list":
            print(json.dumps(await connection.list_tools(), indent=2, ensure_ascii=False))
            return 0
        result = await connection.session.call_tool(args.tool, arguments=json.loads(args.arguments))
        print(json.dumps({
            "isError": bool(getattr(result, "isError", False)),
            "content": [_dump(item) for item in result.content],
            "structuredContent": getattr(result, "structuredContent", None),
        }, indent=2, ensure_ascii=False))
        return 1 if getattr(result, "isError", False) else 0


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("-t", "--transport", choices=["stdio", "sse", "http"], default="stdio")
    common.add_argument("-e", "--env", action="append", help="KEY=VALUE for the server (stdio only; repeatable)")
    common.add_argument("-u", "--url", help="Server URL (sse/http only)")
    common.add_argument("-H", "--header", action="append", help="'Key: Value' header (sse/http only; repeatable)")
    parser = argparse.ArgumentParser(description="Initialize an MCP server, list its tools, or call one tool.")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("list", parents=[common], help="Initialize the server and list its tools")
    call = sub.add_parser("call", parents=[common], help="Initialize the server and call one tool")
    call.add_argument("tool", help="Tool name")
    call.add_argument("arguments", help="Tool arguments as a JSON object; {} for none")
    return parser


def main() -> int:
    # Everything after the first "--" is the command that starts a stdio server; it is never parsed as options.
    argv = sys.argv[1:]
    server = []
    if "--" in argv:
        at = argv.index("--")
        argv, server = argv[:at], argv[at + 1:]
    args = build_parser().parse_args(argv)
    args.server = server
    try:
        return asyncio.run(_run(args))
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
```
