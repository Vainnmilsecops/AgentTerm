---
name: agentterm-security
description: "Review and harden AgentTerm trust boundaries when changes touch shell or process execution, Git, filesystem paths, PTY, agent CLIs, environment variables, credentials, downloads, auto-update, third-party skills, or Windows installers. Use for security-sensitive design, implementation, and review; do not use as a substitute for ordinary correctness testing."
---

# Purpose

Keep untrusted input and powerful local capabilities from causing data loss, credential exposure, or unintended code execution.

# Inputs

- The proposed flow or diff.
- Every input origin, privilege, and external side effect.
- The paths, commands, environment values, downloads, and credentials involved.

# Required Workflow

1. Map the data and control flow before changing code.
2. Mark trust boundaries, including repositories, repository config, agent output, downloaded content, and user-supplied paths.
3. Assess command injection, path traversal, unsafe deletion, credential leakage, arbitrary execution, malicious config, unsafe shell quoting, dangerous Git operations, and supply-chain compromise as applicable.
4. Select the smallest mitigation: structured arguments, strict validation, canonical paths, allowlists, integrity checks, least privilege, or explicit confirmation.
5. For implementation work, add focused negative tests and verify failure behavior. For review work, assess existing evidence and recommend missing tests without editing.
6. Record residual risk instead of implying complete security.

# Invariants

- Treat opened repositories and their config as untrusted input.
- Prefer executable plus argument arrays over interpolated shell strings.
- Resolve and validate destructive filesystem targets against an explicit allowed root.
- Keep secrets out of logs, artifacts, command previews, errors, and persisted environment snapshots.
- Grant only the capability and lifetime required by the operation.

# Forbidden Changes

- Do not interpolate untrusted text into shell commands.
- Do not execute or install downloaded content without provenance and integrity checks.
- Do not weaken validation, sandboxing, confirmation, or signing merely to make a flow pass.
- Do not silently trust a third-party skill, agent response, filename, branch name, or config value.

# Validation

Exercise hostile inputs, quoting edge cases, path escapes, symlink or junction behavior where relevant, secret redaction, and denied operations. Re-run the feature's normal tests after security tests.

# Expected Output

Report the trust boundaries reviewed, threats found, mitigations implemented or recommended, tests run or reviewed, evidence gaps, and remaining risk.
