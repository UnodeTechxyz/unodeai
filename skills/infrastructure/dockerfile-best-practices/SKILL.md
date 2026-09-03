---
name: dockerfile-best-practices
description: Check a Dockerfile against the official Docker best-practices checklist. Use when you need a repeatable dockerfile-best-practices procedure while planning, building, or reviewing work.
---

# Dockerfile Best Practices

Based on Docker official best practices:
1. Use a minimal, pinned base image; avoid latest in production.
2. Order layers from least-frequent to most-frequent change to maximize cache hits.
3. Combine related commands with && and clean up package caches in the same layer.
4. Run as a non-root user and drop privileges explicitly.
5. Copy only required artifacts; never copy secrets or build caches.

Return: Dockerfile issues with line references and safer alternatives.
