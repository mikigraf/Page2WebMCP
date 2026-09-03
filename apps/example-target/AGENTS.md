# Example target site

`@page2webmcp/example-target` is the deployable, non-fixture site a Page2WebMCP
production-live journey analyzes, installs a release on, and verifies.

- It loads the release from the pinned **hosted Supabase Storage object**
  (`app/hosted-release-script.tsx`), never the control-plane artifact route.
- It is deliberately not the Acme fixture: production-live rejects `acme` hosts.
- All state is in memory, per server process, seeded on boot.

Configuration (all required for a working install; missing or invalid values make
the layout render `<meta name="page2webmcp-status" content="release-unconfigured">`):

- `PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL`
- `PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_CONTENT_HASH`
- `PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_INTEGRITY`
- `PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN`
- `PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_EMAIL`
- `PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_PASSWORD`
- `PAGE2WEBMCP_LOCAL_STACK` (`"true"` selects the loopback storage prefix)

The home page reflects the session: signed out it offers sign-in, signed in it
offers sign-out. The website journey's authentication observer looks for exactly
that affordance on `/` to confirm an operator session, so removing it would make
the handoff unverifiable.

Website-ownership verification (only while a challenge is pending): set
`PAGE2WEBMCP_EXAMPLE_TARGET_OWNERSHIP_VERIFICATION` to the exact three-line content the
control plane displays (literal or `\n`-escaped newlines) and
`/.well-known/page2webmcp-verification.txt` serves it as plain text; otherwise 404.
