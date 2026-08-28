# Three-minute local demo

Start both applications in separate terminals:

```bash
pnpm --filter @page2webmcp/control-plane dev
pnpm --filter @page2webmcp/acme-support dev
```

Run `pnpm demo:seed` to print local URLs and fixture-only credentials. In the control plane, sign in as the fixture owner, then create Website, OpenAPI, and GitHub projects using the URLs documented in [OPERATIONS.md](OPERATIONS.md). Review the proposed capabilities, approve the R1 ticket action, and publish. The generated release is served from Acme Support; the automated browser test proves installing it creates a visible ticket in the fixture UI.

For a fully unattended demonstration, run `pnpm test:all`.
