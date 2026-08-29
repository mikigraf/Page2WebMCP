# Local fixture demo

Install dependencies, copy the safe local environment, and start both applications:

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm demo:seed
pnpm dev
```

Open `http://127.0.0.1:3100` and sign in as `owner@example.test` with `fixture-password`.

Exercise the three committed sources:

- Website: `https://acme.example`
- OpenAPI: `https://acme.example/openapi.json`
- GitHub: `https://github.com/acme/support`

For Website or OpenAPI, create the project, run analysis, review the proposed capabilities, and publish. The R3 `delete_account` capability remains blocked; the R1 `create_support_ticket` capability requires owner approval. The resulting link is the immutable, content-addressed artifact served by the control plane. The GitHub path produces the existing deterministic draft-hardening result and is not publishable from the UI.

Run the unattended production-mode acceptance flow with:

```bash
pnpm build
pnpm test:e2e:production
```

The automated browser flow installs the generated artifact in the Acme fixture, performs an authenticated and confirmed ticket creation, and verifies that the ticket persists after reload.
