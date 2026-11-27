---
name: dependency-risk-triage
description: Audit third-party dependencies for vulnerabilities, staleness, license issues, and bloat in any package ecosystem. Use when you need a repeatable dependency-risk-triage procedure while planning, building, or reviewing work.
---

# Dependency Risk Triage

1. Find the package managers in use from their manifests and lock files (for example `package.json`,
   `requirements.txt` or `poetry.lock`, `go.mod`, `Cargo.toml`, `pom.xml` or `build.gradle`, `Gemfile`,
   `composer.json`, `*.csproj`). Triage each one.
2. **Vulnerabilities**: run the ecosystem's audit tool where it is available, for example `npm audit --json`,
   `pip-audit`, `govulncheck ./...`, `cargo audit`, `bundle audit`, `dotnet list package --vulnerable`, or
   OSV-Scanner across ecosystems. Record each critical or high finding with its advisory ID, package, installed
   version and fixed version. If no tool can run, say which checks were not done.
3. **Staleness**: dependencies far behind their latest release, or no longer maintained. Note the lag and how
   hard an upgrade looks.
4. **Licences**: read licences with the ecosystem's tool or from package metadata. Flag licences that conflict
   with the project's own licence or policy, and packages with no licence.
5. **Weight**: a large dependency used for one small function. Suggest a smaller option only when one exists.
6. **Transitive risk**: deep or wide dependency chains, and packages that only one direct dependency pulls in.

Output: a risk-ranked report naming each ecosystem, the tools you ran and their results, and clear actions.
