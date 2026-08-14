# ADR-002 — Desktop Application Framework

- Status: Accepted
- Date: 2026-08-10

## Decision

Use Electron with a React/Vite renderer for the AgentTerm Windows desktop MVP.

## Alternatives Considered

- Tauri offers a smaller runtime and strong native integration, but requires Rust, Cargo, Microsoft C++ Build Tools, and WebView2. This environment has no Rust toolchain, and adopting Rust now would add a second implementation ecosystem before the PTY/runtime design exists.
- Electron ships Chromium and Node.js, increasing download size and memory use, but gives the future process/PTY adapters a direct, mature Node-capable outer runtime while keeping the renderer React-based.

## Security and Runtime Tradeoffs

The renderer is sandboxed, has Node integration disabled, and uses context isolation. It loads only local bundled content, rejects new windows and navigation, and defines a restrictive Content Security Policy. Future IPC must expose narrow, validated operations rather than raw Electron or process APIs.

Electron's larger binary and privileged main process remain accepted MVP costs. Packaging, signing, installer behavior, updates, PTY selection, and IPC contracts are deferred.

## Consequences

- Desktop renderer Presentation depends on Application-facing contracts only; native capabilities live behind Infrastructure ports/adapters. The Electron main entrypoint is the outer composition root and may depend on both Application and Infrastructure to bind those ports, but it must expose them to the renderer only through the validated preload/IPC boundary.
- Electron must be kept current because its Chromium and Node runtimes are part of the shipped security surface.
- A later ADR is required before replacing Electron or introducing a second desktop runtime.
