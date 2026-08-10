---
name: agentterm-windows-packaging
description: "Design, implement, or review AgentTerm Windows packaging and release work involving Windows x64 builds, executables, runtime dependencies, installers, portable archives, versioning, checksums, code signing, upgrades, rollback, release manifests, or GitHub Releases. Use only for desktop distribution and release concerns, not ordinary feature development."
---

# Purpose

Produce traceable Windows artifacts that install, upgrade, run, and roll back without damaging user projects or application data.

# Inputs

- Target version, source revision, architecture, and release channel.
- Runtime dependencies and supported Windows versions.
- Signing availability, upgrade policy, and artifact destination.

# Required Workflow

1. Establish whether the request is design, implementation, release execution, or review; do not build, sign, publish, or edit during a design or review-only request.
2. Define or verify the version and artifact contract before building.
3. Inventory bundled and external runtime dependencies.
4. When implementation or release execution is requested, build the Windows x64 application from a known source state.
5. Produce and independently exercise the installer and portable archive when required by the requested release work.
6. Generate SHA-256 checksums and a release manifest tied to the source revision for produced artifacts.
7. Sign eligible binaries and installer artifacts only through the approved signing boundary and only when authorized.
8. Test clean install, launch, upgrade compatibility, uninstall behavior, and rollback or recovery for release execution; during review, inspect the available evidence and report gaps.
9. Publish to GitHub Releases only when explicitly requested and all gates pass.

# Invariants

- Use stable names such as `AgentTerm-win-x64.zip` and `AgentTerm-Setup-x64.exe` unless the release contract says otherwise.
- Preserve user projects, worktrees, settings, and recoverable data across upgrade and uninstall.
- Keep signing credentials outside the repository, logs, and produced archives.
- Make artifact provenance, version, architecture, and checksum unambiguous.

# Forbidden Changes

- Do not silently change versions or release channels.
- Do not publish unsigned or unverified artifacts as if they were final.
- Do not assume installer and portable builds have identical runtime behavior.
- Do not introduce a packaging tool or release pipeline without a demonstrated need and review.

# Validation

Verify the evidence available within the requested mode: artifact names, architecture, version metadata, dependencies, signatures, SHA-256 values, manifest contents, install and upgrade paths, rollback behavior, and clean-machine startup. Do not claim checks that were not executed.

# Expected Output

Report artifacts produced or reviewed, provenance, checksums, signature status, install and upgrade evidence, known limitations, and publication status.
