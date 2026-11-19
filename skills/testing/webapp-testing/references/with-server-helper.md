> Adapted from the upstream `webapp-testing` skill (Apache-2.0); the changes are listed in `SOURCE.md`.

# Helper: run a check with one or more local servers

Upstream shipped this as `scripts/with_server.py`. Skill folders here carry no scripts, so it is reference text.
When you want it, write the code below into the workspace yourself, for example as `.skill-helpers/with_server.py`,
and run it with your normal command permission. Tell the user where you wrote it, and remove it when the task is done
unless they want to keep it.

## What it does

Starts each server command, waits until its port accepts connections, runs your command (for example a Playwright
script), and then stops every server it started, including the processes the server command itself started. Each
server's output goes to a log file, so a crash or an error message can be read afterwards. It exits with your
command's exit status.

It needs Python 3.8 or later and nothing else.

## Usage

Run from the project folder (use `py -3` instead of `python` where that is how Python is started on Windows).

Single server:

```text
python .skill-helpers/with_server.py --server "npm run dev" --port 5173 -- python .skill-helpers/check_page.py
```

Several servers (for example a backend and a frontend):

```text
python .skill-helpers/with_server.py --server "cd backend && python server.py" --port 3000 --server "cd frontend && npm run dev" --port 5173 -- python .skill-helpers/check_page.py
```

| Option | Meaning |
| --- | --- |
| `--server` | A server command; repeat it for each server. It runs through the system shell, so `cd dir && ...` works. |
| `--port` | The port of each server, in the same order as `--server`. |
| `--timeout` | Seconds to wait for each server's port (default 30). |
| `--log-dir` | Folder for the server logs (default `.skill-helpers/logs`). |

Your automation script then contains only browser logic; the servers are already up when it starts.

## Code

```python
#!/usr/bin/env python3
"""
Start one or more servers, wait for them to be ready, run a command, then clean up.

Usage:
    # Single server
    python with_server.py --server "npm run dev" --port 5173 -- python automation.py
    python with_server.py --server "npm start" --port 3000 -- python test.py

    # Multiple servers
    python with_server.py \
      --server "cd backend && python server.py" --port 3000 \
      --server "cd frontend && npm run dev" --port 5173 \
      -- python test.py
"""

import argparse
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path


def is_server_ready(port, process, timeout=30):
    """Wait for the server's port to accept connections.

    Adapted: stops waiting as soon as the server process has exited, instead of waiting out the timeout.
    """
    start_time = time.time()
    while time.time() - start_time < timeout:
        if process.poll() is not None:
            return False
        try:
            with socket.create_connection(('localhost', port), timeout=1):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def start_server(command, log_path):
    """Adapted: output goes to a log file, and the server starts in its own process group.

    Upstream piped the output and never read it; a server that writes a lot can then stall on a full pipe.
    Its own process group lets stop_server reach the processes the server command starts.
    """
    log = open(log_path, 'wb')
    options = {}
    if os.name == 'nt':
        options['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options['start_new_session'] = True
    process = subprocess.Popen(command, shell=True, stdout=log, stderr=subprocess.STDOUT, **options)
    return process, log


def stop_server(process):
    """Adapted: stop the whole process tree, not only the shell.

    With shell=True, terminate() stops only the shell; on Windows the dev server it started keeps running and keeps
    the port. taskkill /T ends the tree on Windows; elsewhere the process group is signalled.
    """
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name != 'nt':
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.kill()
        process.wait()


def main():
    parser = argparse.ArgumentParser(description='Run command with one or more servers')
    parser.add_argument('--server', action='append', dest='servers', required=True, help='Server command (can be repeated)')
    parser.add_argument('--port', action='append', dest='ports', type=int, required=True, help='Port for each server (must match --server count)')
    parser.add_argument('--timeout', type=int, default=30, help='Timeout in seconds per server (default: 30)')
    parser.add_argument('--log-dir', default=os.path.join('.skill-helpers', 'logs'), help='Folder for server logs')
    parser.add_argument('command', nargs=argparse.REMAINDER, help='Command to run after server(s) ready')

    args = parser.parse_args()

    # Remove the '--' separator if present
    if args.command and args.command[0] == '--':
        args.command = args.command[1:]

    if not args.command:
        print("Error: No command specified to run")
        sys.exit(1)

    # Parse server configurations
    if len(args.servers) != len(args.ports):
        print("Error: Number of --server and --port arguments must match")
        sys.exit(1)

    log_dir = Path(args.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    servers = []
    for cmd, port in zip(args.servers, args.ports):
        servers.append({'cmd': cmd, 'port': port})

    server_processes = []
    log_files = []

    try:
        # Start all servers
        for i, server in enumerate(servers):
            print(f"Starting server {i+1}/{len(servers)}: {server['cmd']}")
            log_path = log_dir / f"server-{i+1}-port-{server['port']}.log"
            process, log = start_server(server['cmd'], log_path)
            server_processes.append(process)
            log_files.append(log)

            # Wait for this server to be ready
            print(f"Waiting for server on port {server['port']} (log: {log_path})...")
            if not is_server_ready(server['port'], process, timeout=args.timeout):
                state = 'exited' if process.poll() is not None else f"was not ready within {args.timeout}s"
                raise RuntimeError(f"Server on port {server['port']} {state}; see {log_path}")

            print(f"Server ready on port {server['port']}")

        print(f"\nAll {len(servers)} server(s) ready")

        # Run the command
        print(f"Running: {' '.join(args.command)}\n")
        result = subprocess.run(args.command)
        sys.exit(result.returncode)

    finally:
        # Clean up all servers
        print(f"\nStopping {len(server_processes)} server(s)...")
        for i, process in enumerate(server_processes):
            stop_server(process)
            print(f"Server {i+1} stopped")
        for log in log_files:
            log.close()
        print("All servers stopped")


if __name__ == '__main__':
    main()
```
