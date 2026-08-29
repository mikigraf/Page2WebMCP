# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability. Contact the repository owner privately with a minimal reproduction, affected component, and impact. Do not include passwords, session cookies, bearer tokens, private URLs, or browser debugging endpoints.

## Security boundaries

Page2WebMCP accepts only the fixed, explicitly allowlisted HTTPS Acme and GitHub fixture URLs; the current adapters do not traverse arbitrary redirects or fetch arbitrary targets. It blocks discovery mutations, redacts sensitive-keyed evidence, and only publishes after deterministic verification gates pass. Generated tools are same-origin, use strict schemas, and do not expose cross-origin tool access.

The included fixture credentials are public test data only. All live provider credentials belong in a local `.env` or deployment secret manager.
