---
name: agentterm-website
description: "Build or revise the separate AgentTerm marketing website when work concerns product storytelling, feature demos, documentation, changelog, Windows downloads, or GitHub links. Apply only to the public website, never to the core desktop terminal workspace; do not introduce SaaS dashboard, login, billing, accounts, or a complex backend without an explicit requirement."
---

# Purpose

Present AgentTerm clearly as a downloadable Windows terminal workspace built specifically for AI coding agents.

# Inputs

- Audience, product claims, page goal, and required content.
- Available screenshots, demos, release links, documentation, and brand assets.
- Accessibility, performance, and responsive-layout constraints.

# Required Workflow

1. Establish the page's story and primary download or documentation action.
2. Design a minimal information hierarchy around product value, credible feature demonstrations, docs, changelog, and GitHub access.
3. Use a dark, premium, terminal-inspired visual direction with strong typography and restrained motion.
4. Make the Windows download call to action prominent and label artifact requirements accurately.
5. Implement responsive, keyboard-accessible behavior with useful loading, error, and unavailable-download states.
6. Verify claims and links against actual product and release state.

# Invariants

- Keep the website separate from desktop application architecture and workflows.
- Prefer clear product demonstration over decorative terminal effects.
- Preserve readability, contrast, focus visibility, reduced-motion support, and mobile usability.
- Describe only features that exist or are explicitly labeled as planned.

# Forbidden Changes

- Do not turn the site into a SaaS dashboard.
- Do not add login, billing, user accounts, or a complex backend without requirements.
- Do not invent download URLs, release status, usage metrics, testimonials, or security claims.
- Do not copy infrastructure or business logic into presentation-only website code.

# Validation

Check responsive layouts, keyboard navigation, contrast, reduced motion, link integrity, download labeling, metadata, performance, and factual product claims.

# Expected Output

Report the page or content changed, user journey, responsive and accessibility checks, verified links or claims, and any missing product asset.
