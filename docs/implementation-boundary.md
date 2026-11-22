# QGitGraph · independent implementation

This project implements a compact desktop Git client from public feature descriptions and Git's documented command interface. It is not a repackaged VS Code extension.

## Source boundary

- No upstream Git Graph source files, stylesheets, assets, compiled bundles, message contracts, logos or trademarks are included.
- The upstream custom license is **not MIT** and does not grant permission to publish or distribute derivative works. This project must not import that implementation without a separate suitable authorization.
- Feature descriptions are inputs to a parity checklist, not code templates. Interface assets and protocols are written independently.
- This is not a legal opinion or a guarantee that an independent implementation can duplicate every protected aspect. Distribution review remains the publisher's responsibility.

## Product constraints

One main window. System WebView2 and an existing Git installation. No bundled Chromium or Node runtime, no telemetry, no server, no background synchronisation, no CDN, no downloaded fonts. Optional third-party avatars remain off unless explicitly enabled.

The visual reference is a dense Git history table, not a marketing landing page. System fonts, clear focus, restrained color and functional spacing take precedence over generic design-library recommendations.

## Sources

- Public feature reference: https://marketplace.visualstudio.com/items?itemName=mhutchie.git-graph
- Upstream license: https://github.com/mhutchie/vscode-git-graph/blob/develop/LICENSE
- Git command documentation: https://git-scm.com/docs
- Tauri distribution: https://v2.tauri.app/distribute/windows-installer/
- WebView2 distribution: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
