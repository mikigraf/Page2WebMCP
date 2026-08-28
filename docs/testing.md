# Testing

Run the complete credential-free local suite from the repository root:

```bash
pnpm infra:down
pnpm test:all
pnpm test:db:local
```

`infra:down` is safe when no infrastructure is running; default tests use in-process service lifecycle instead of Docker. `test:all` runs linting, TypeScript checks, Node tests, a Node end-to-end test, and browser tests. `test:db:local` applies the committed migration to disposable PostgreSQL and exercises owner, cross-tenant viewer, and anonymous access.

The CI workflow runs the same suite plus production builds. Live-provider checks are deliberately not part of the default test contract because they require separately provisioned disposable accounts and a public deployment.
