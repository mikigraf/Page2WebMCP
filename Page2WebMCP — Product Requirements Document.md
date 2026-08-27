# Page2WebMCP — Product Requirements Document

## Paste your website or OpenAPI URL → get a production-ready WebMCP layer in minutes

**Version:** 1.0  
**Date:** August 26, 2026  
**Hackathon:** The WebMCP Challenge  
**Build window:** 72 hours  
**Primary platform:** Google Chrome 149+ and ChatGPT’s in-app browser  
**Initial framework support for source mode:** Next.js App Router with TypeScript

---

# 1. Executive Summary

Page2WebMCP turns an existing website or API into an agent-native web application.

The user begins with one of three paths:

1. **Website URL — Autonomous Discovery**
   - Paste the URL.
   - Verify ownership.
   - Authenticate manually inside an isolated Browser Use session.
   - Mastra-orchestrated agents autonomously explore the application.
   - Playwright and Chrome DevTools Protocol instrumentation capture deterministic evidence.
   - Page2WebMCP generates, verifies, and packages WebMCP tools.

2. **OpenAPI URL or file — Contract Compilation**
   - Import an OpenAPI document.
   - Page2WebMCP converts low-level operations into user-oriented capabilities.
   - It generates browser-safe tools or a server adapter where credentials cannot safely exist in the browser.
   - It verifies request serialization, authentication behavior, outputs, and agent tool selection.

3. **GitHub repository — Source Hardening**
   - Connect a Next.js repository.
   - Page2WebMCP discovers routes, forms, Server Actions, schemas, authorization checks, and services.
   - It generates a source-native WebMCP implementation.
   - It opens a tested draft pull request and optionally validates it through a Vercel preview deployment.

All three paths compile to the same internal **Capability Graph** and pass through the same security, evaluation, release, installation, and versioning pipeline.

```text
Website runtime evidence
        +
OpenAPI contract evidence
        +
GitHub source evidence
        ↓
Normalized Capability Graph
        ↓
Security classification
        ↓
Human review
        ↓
Deterministic verification
        ↓
Agent-selection evals
        ↓
Versioned WebMCP release
```

The URL path is the primary hackathon magic moment. The user does not manually record workflows or describe every feature. They authenticate once and Page2WebMCP explores the application autonomously.

The GitHub path is not presented as the main product because that would make Page2WebMCP look like a conventional coding agent. It is positioned as an optional **source-hardening and installation path**.

The OpenAPI path provides the most deterministic conversion for documented APIs.

Page2WebMCP’s generated production runtime has no dependency on Browser Use, Mastra, or the Page2WebMCP control plane. Once installed, tools execute inside the customer’s website using the application’s existing session, authorization logic, and APIs.

---

# 2. Product Positioning

## 2.1 Primary positioning

> **Page2WebMCP**  
> **Paste your website or OpenAPI URL → get a production-ready WebMCP layer in minutes.**

## 2.2 Supporting message

> Authenticate once and let our agents explore your application, identify useful workflows, generate structured WebMCP tools, and verify that they work safely.

## 2.3 GitHub supporting message

> Connect your Next.js repository to confirm authorization, replace inferred adapters with application-native handlers, and receive a tested pull request.

## 2.4 One-line pitch

> **Page2WebMCP is the compiler that turns existing websites and APIs into production-grade WebMCP applications.**

## 2.5 Technical positioning

> **Mastra orchestrates. Browser Use explores. CDP proves. Page2WebMCP compiles.**

## 2.6 Competitive distinction

Generic coding agents begin with source code and a human-written implementation request.

Page2WebMCP begins with the application itself:

- what users can do;
- how the live application behaves;
- which requests it makes;
- which schemas and authorization paths exist;
- which capabilities are safe for agents;
- how those capabilities can be tested and released.

The GitHub agent is only one stage in a larger evidence, security, and release pipeline.

---

# 3. Why This Product Exists

WebMCP lets web pages register structured tools that browser agents can discover and call. The August 26, 2026 specification defines `document.modelContext.registerTool()`, `getTools()`, `executeTool()`, input JSON Schemas, cancellation, exposure controls, and the `readOnlyHint` and `untrustedContentHint` annotations. The specification remains a Community Group draft rather than a W3C Standard, and its declarative section is still incomplete. Page2WebMCP should therefore generate the imperative JavaScript API as its canonical implementation.

Chrome currently supports WebMCP through an origin trial beginning with Chrome 149 and through the local `chrome://flags/#enable-webmcp-testing` flag. WebMCP requires a browser or WebView context, and tools are discovered after the site is visited. The `tools` permissions policy defaults to same-origin access.

Today, adding WebMCP to an existing application requires a team to:

- identify which user workflows should become tools;
- find the underlying APIs or application functions;
- write accurate tool names and descriptions;
- construct strict input schemas;
- preserve authentication and authorization;
- understand side effects;
- add confirmation and safety controls;
- test deterministic behavior;
- test probabilistic tool selection;
- install and maintain the generated layer.

Page2WebMCP automates that process while preserving human control.

---

# 4. Hackathon Fit

The challenge asks for a complete WebMCP-powered product experience that meaningfully improves how people and agents work together. Judging is based equally on WebMCP leverage, execution, potential impact, and creativity and ambition. Submissions require a working live URL, a public source repository with an open-source license, and a public demo video shorter than three minutes. The deadline is September 3, 2026 at 1:00 PM Pacific Time, corresponding to 10:00 PM in Germany.

Page2WebMCP is particularly strong against the criteria:

| Criterion | Page2WebMCP response |
|---|---|
| WebMCP leverage | The product directly creates, tests, versions, and installs WebMCP tools |
| Execution | Three complete input paths and a working generated application |
| Potential impact | Reduces adoption from a bespoke engineering project to a guided workflow |
| Creativity and ambition | Autonomously derives an agent interface from a live authenticated website |

The demo must concentrate on the URL path because it most clearly demonstrates something that was difficult or impossible before:

> A website owner provides only a deployed application, authenticates, and receives structured agent tools without manually exposing every capability.

---

# 5. Goals

## 5.1 Hackathon goals

- Deliver working Website URL, OpenAPI, and GitHub paths.
- Make the Website URL path the primary onboarding and live demonstration.
- Generate real imperative WebMCP tools.
- Support one authenticated read workflow and one authenticated low-risk mutation.
- Avoid persisting passwords, cookies, bearer tokens, or refresh tokens.
- Verify generated tools through direct execution and natural-language tool-selection tests.
- Publish an immutable installable bundle.
- Open a working draft PR through the GitHub path.
- Demonstrate the same capabilities being derived from all three evidence sources.
- Fit the complete live demonstration into three minutes.

## 5.2 Product goals

- First capability candidates within 90 seconds for the demonstration application.
- Verified release within five minutes for a supported small application.
- Every generated tool must include traceable evidence.
- Every generated tool must have explicit inputs, outputs, effects, risk, authentication strategy, and success criteria.
- No tool may receive a production-ready status solely because an LLM generated valid-looking code.
- The generated runtime must continue functioning if Page2WebMCP is unavailable.
- Unsupported applications must receive clear diagnostics instead of silently unreliable tools.

---

# 6. Non-Goals

The 72-hour version does not aim to:

- convert every arbitrary website;
- bypass CAPTCHA, MFA, rate limits, or bot protections;
- explore websites the user does not own or administer;
- extract or export authentication tokens;
- persist full browser profiles;
- reproduce unknown private framework protocols;
- expose payments, purchases, transfers, password resets, permission changes, or account deletion;
- support arbitrary source frameworks;
- support GraphQL, WebSockets, streaming, multipart uploads, or file workflows;
- autonomously merge pull requests;
- autonomously publish production changes without owner approval;
- make formal guarantees that the evolving WebMCP draft will remain API-compatible;
- replace the target application’s own authentication and authorization system.

---

# 7. Target Users

## 7.1 SaaS founder

**Situation:** Has an existing application but no dedicated agent API.

**Job to be done:**

> When I want agents to use my product, identify and expose the workflows that already exist without making me design the integration from scratch.

## 7.2 Product engineer

**Situation:** Understands the codebase but has not followed WebMCP’s evolving specification.

**Job to be done:**

> Generate a correct implementation, security review, tests, and installation change that I can inspect and ship.

## 7.3 Agency or software consultancy

**Situation:** Maintains multiple applications with inconsistent documentation.

**Job to be done:**

> Assess and enable WebMCP across customer websites using a repeatable workflow.

## 7.4 API platform team

**Situation:** Has a high-quality OpenAPI contract but no browser-agent integration.

**Job to be done:**

> Convert my existing API contract into agent-friendly capabilities without exposing credentials in browser code.

## 7.5 Internal tools team

**Situation:** Owns authenticated applications with many repetitive workflows.

**Job to be done:**

> Let employees and their agents complete common tasks more reliably than UI automation alone.

---

# 8. Product Principles

## 8.1 URL-first magic

The first successful experience should require only a website URL, ownership verification, and user authentication.

## 8.2 Autonomous discovery, controlled execution

Agents may explore autonomously, but deterministic policy enforcement—not an agent prompt—controls which requests and actions are allowed.

## 8.3 No credential extraction

Page2WebMCP learns how authentication is carried without copying credential values.

## 8.4 Fail closed

Unknown authorization, unstable requests, ambiguous side effects, or missing success criteria block production publication.

## 8.5 Evidence before generation

Every proposed capability must point to the evidence that produced it.

## 8.6 Human approval for effects

The user approves tool semantics and every mutation-validation plan.

## 8.7 Existing authorization remains authoritative

Generated tools call existing application logic or existing secured APIs. They do not create an authorization bypass.

## 8.8 AI at compile time, deterministic code at runtime

LLMs help interpret evidence and design capabilities. Production tool execution follows generated deterministic templates.

## 8.9 Minimal exposure

Expose the smallest set of useful capabilities and the smallest input and output surface for each tool.

## 8.10 Reversible releases

Every release is versioned, immutable, inspectable, and rollbackable.

## 8.11 Honest production status

“Production-ready” is a mechanically gated state, not a synonym for “generated.”

---

# 9. Product Status Model

Each capability progresses through explicit states.

## 9.1 Discovered

Page2WebMCP has found evidence of a user workflow.

No code has been approved or verified.

## 9.2 Proposed

Page2WebMCP has generated:

- tool identity;
- description;
- input schema;
- expected output;
- execution strategy;
- risk;
- effects;
- authentication classification;
- evidence links.

## 9.3 Reviewed

The owner has approved or edited:

- purpose;
- name;
- description;
- inputs;
- output projection;
- effects;
- confirmation policy;
- allowed execution strategy.

## 9.4 Verified

The capability has passed:

- schema tests;
- direct execution;
- authentication-negative tests;
- expected state transition;
- output projection;
- secret-leakage checks;
- agent tool-selection evals;
- browser registration test.

## 9.5 Production-ready

In addition to being verified:

- domain ownership is verified;
- execution strategy is production-eligible;
- authentication is safe;
- authorization is confirmed or explicitly attested;
- no high-severity security issue remains;
- mutation confirmation is present where required;
- installation smoke test passes;
- release is immutable and origin-locked;
- owner explicitly publishes the version;
- rollback instructions exist.

## 9.6 Blocked

The capability cannot be safely generated.

Possible reasons:

- consequential action;
- unknown authorization;
- unstable UI bridge;
- unsupported authentication;
- missing test resource;
- source conflict;
- external secret required in browser code;
- ambiguous side effects;
- prompt-injection risk;
- sensitive-data exposure.

---

# 10. Product Entry Experience

## 10.1 Landing page

```text
Page2WebMCP

Paste your website or OpenAPI URL
→ get a production-ready WebMCP layer in minutes.

[ https://                                  ] [Analyze]

                     or

                 [Connect GitHub]
```

## 10.2 URL type detection

The primary input automatically classifies the submitted URL:

### Website

Detected from:

- HTML response;
- application routes;
- forms;
- scripts;
- rendered user interface.

### OpenAPI

Detected from:

- JSON or YAML content;
- root `openapi` property;
- recognized OpenAPI version;
- API content type or filename.

### Ambiguous

The product asks:

```text
What did you provide?

[Website] [OpenAPI specification]
```

## 10.3 Project creation

A project contains:

- primary verified origin;
- evidence sources;
- capabilities;
- tests;
- releases;
- installations;
- audit history.

## 10.4 Source cards

```text
Live Website
Autonomously explore an authenticated application.
[Connect]

OpenAPI
Generate tools from a formal API contract.
[Connect]

GitHub
Harden and install through a Next.js pull request.
[Connect]
```

A project may use one, two, or all three.

---

# 11. Path A — Website URL: Autonomous Discovery

## 11.1 User promise

> Paste a website you own, authenticate once, and let Page2WebMCP discover which workflows should become WebMCP tools.

## 11.2 Supported MVP envelope

The URL path may reach production-ready status for applications with:

- HTTPS;
- verified ownership;
- standard browser authentication;
- same-origin JSON APIs or standard HTML forms;
- stable semantic UI labels;
- read operations;
- reversible low-risk mutations;
- deterministic success signals;
- no browser-embedded server secrets;
- compatible CSP and origin isolation.

The URL path may discover but not publish capabilities using:

- opaque Next.js Server Action transport;
- complex GraphQL;
- WebSockets;
- cross-origin APIs with server secrets;
- unknown authorization;
- unstable canvas-only interfaces;
- non-semantic controls;
- high-risk actions.

## 11.3 Step A1 — Safe public preflight

After receiving the URL, Page2WebMCP:

1. normalizes the URL;
2. permits only HTTPS;
3. rejects embedded credentials;
4. resolves DNS;
5. rejects loopback, private, link-local, multicast, and metadata addresses;
6. validates every redirect destination;
7. caps redirects and response size;
8. checks content type;
9. detects existing WebMCP registrations;
10. inspects CSP and origin-isolation compatibility;
11. identifies likely login and application routes;
12. discovers likely authentication origins.

No authenticated exploration begins yet.

## 11.4 Step A2 — Ownership verification

Authenticated exploration requires one of:

- DNS TXT record;
- `/.well-known/page2webmcp-verification.txt`;
- HTML meta tag;
- matching connected GitHub repository;
- preconfigured demonstration fixture.

The user also confirms:

```text
I own this application or am authorized to analyze it.
```

Unauthenticated public analysis may produce a basic readiness report, but it cannot publish a production release.

## 11.5 Step A3 — Exploration scope

Before authentication, the user configures an allowlist.

```text
Explore:

✓ /dashboard
✓ /orders
✓ /tickets
✓ /projects

Exclude:

✕ /billing
✕ /settings/security
✕ /admin
✕ /users/permissions
```

The product automatically blocks commonly sensitive areas unless explicitly overridden:

- billing;
- payments;
- security;
- authentication;
- password management;
- permissions;
- access control;
- administrator management;
- account deletion.

Allowed origins are also explicit:

```text
app.example.com
auth.example.com
```

All other origins are blocked by default.

## 11.6 Step A4 — Isolated Browser Use session

Page2WebMCP creates an ephemeral Browser Use browser session.

Browser Use supports live browser views, session continuation, structured output, human interaction, and CDP connections. Its profiles persist cookies and local storage across sessions, so Page2WebMCP must not use persistent profiles by default.

Proposed Browser Use configuration:

```ts
{
  keepAlive: true,
  enableRecording: false,
  profileId: null,
  workspaceId: null,
  enableScheduledTasks: false,
  skills: false,
  agentmail: false,
  cacheScript: false,
  maxCostUsd: 2
}
```

Security defaults:

- no persistent profile;
- no saved password;
- no scheduled tasks;
- no temporary email inbox;
- no unnecessary built-in skills;
- no session recording;
- no downloads;
- no file upload;
- one project per browser session;
- browser terminated after the scan;
- live-view and CDP URLs encrypted as short-lived secrets.

## 11.7 Step A5 — Human authentication handoff

Page2WebMCP embeds the Browser Use live view.

The Mastra workflow suspends and displays:

> Sign in directly inside this isolated browser. Page2WebMCP does not ask for or persist your password.

The user handles:

- username;
- password;
- passkey;
- MFA;
- SSO;
- CAPTCHA;
- consent dialogs.

The explorer agent is paused during authentication.

The user clicks:

```text
I’m signed in — start autonomous discovery
```

Page2WebMCP verifies authenticated state using non-secret indicators:

- route changed;
- login form disappeared;
- authenticated navigation appeared;
- signed-in account control exists;
- expected authenticated request returned successfully.

Page2WebMCP does not claim that Browser Use itself cannot process browser content. Browser Use is a third-party processing boundary. The product clearly advises using staging or a dedicated test account for the hackathon build.

## 11.8 Step A6 — Attach deterministic instrumentation

Playwright connects to the Browser Use Chromium session over CDP.

```text
Mastra Explorer Agent
        ↓
Browser Use Chromium
        ├── Human live view
        ├── Agent navigation
        └── Playwright/CDP observer
                ├── DOM evidence
                ├── accessibility tree
                ├── network events
                ├── route transitions
                ├── state diffs
                └── policy enforcement
```

Browser Use provides autonomous navigation.

Playwright and CDP provide authoritative evidence.

An LLM statement such as “this creates a support ticket” is not sufficient. Page2WebMCP must correlate it with deterministic evidence such as:

```text
Button:
Create ticket

Form:
orderId, title, priority

Network:
POST /api/tickets

Response:
201

Visible postcondition:
new ticket row appears
```

## 11.9 Step A7 — Read-only request firewall

Autonomous exploration begins in a mechanically enforced read-only mode.

The firewall allows:

- same-origin `GET`;
- same-origin `HEAD`;
- static assets;
- approved authentication-origin redirects;
- explicitly allowlisted safe requests.

The firewall blocks:

- `POST`;
- `PUT`;
- `PATCH`;
- `DELETE`;
- file downloads;
- external navigation;
- form submission;
- logout;
- payment endpoints;
- security-setting endpoints;
- suspicious state-changing `GET` URLs.

Blocked requests are recorded as candidate actions without executing them.

```text
POST /api/tickets
Blocked during discovery
Candidate mutation recorded
```

The policy is enforced by CDP interception and browser configuration, not only by an agent prompt.

## 11.10 Step A8 — Autonomous exploration strategy

The Explorer follows a bounded breadth-first strategy.

### Exploration priorities

1. primary application navigation;
2. entity list pages;
3. entity detail pages;
4. search and filtering;
5. create and update forms;
6. settings pages outside excluded categories;
7. secondary menus and dialogs.

### State identity

A page state is identified by a fingerprint containing:

- origin;
- normalized route;
- page title;
- heading hierarchy;
- accessibility roles;
- visible forms;
- primary actions;
- structural DOM hash.

### Budgets

For the MVP:

```text
Maximum pages: 30
Maximum browser steps: 100
Maximum scan duration: 10 minutes
Maximum application origins: 3
Maximum capability candidates: 20
Maximum model cost: configured per project
```

### Stop conditions

Exploration ends when:

- no unseen safe actions remain;
- page budget is exhausted;
- time budget is exhausted;
- session expires;
- repeated navigation loop is detected;
- request firewall detects suspicious behavior;
- user cancels.

## 11.11 Step A9 — Evidence collection

### DOM evidence

Collect:

- route;
- page title;
- headings;
- labels;
- accessible names;
- form structure;
- field types;
- required state;
- enum options;
- validation messages;
- button labels;
- visible confirmation text.

### Network evidence

Collect sanitized shapes:

- method;
- same-origin classification;
- normalized path;
- query parameter names;
- request field names and inferred types;
- response field names and inferred types;
- status codes;
- timing;
- relationship to a UI action.

Never persist:

- `Cookie`;
- `Set-Cookie`;
- `Authorization`;
- password values;
- OTP values;
- refresh tokens;
- session IDs;
- raw CSRF values;
- payment details;
- full private records.

Instead, store metadata:

```json
{
  "authentication": {
    "carrier": "same-origin-cookie",
    "credentialValueStored": false
  },
  "csrf": {
    "required": true,
    "carrier": "header",
    "name": "x-csrf-token",
    "resolver": "meta[name=csrf-token]",
    "valueStored": false
  }
}
```

### State-diff evidence

Collect:

- route changes;
- new or removed rows;
- new identifiers;
- counter changes;
- toast messages;
- dialog state;
- status changes;
- expected success and error states.

## 11.12 Step A10 — Mastra agent roles

Only one agent controls the browser at a time.

Evidence-analysis agents may run in parallel after evidence has been captured.

### Explorer Agent

Responsibilities:

- navigate the application;
- prioritize useful areas;
- stay inside scope;
- identify likely user workflows;
- avoid all mutations.

### Cartographer Agent

Input:

- sanitized page graph;
- semantic UI evidence.

Output:

- application sections;
- entities;
- relationships;
- likely workflows;
- role-specific areas.

### Protocol Analyst

Input:

- sanitized DOM events;
- network shapes;
- state diffs.

Output:

```text
UI action
→ request
→ authentication mode
→ response
→ visible state transition
```

### Capability Designer

Transforms observations into user-oriented tools.

Bad:

```text
post_api_tickets
```

Good:

```text
create_support_ticket
```

### Security Critic

Reviews:

- actual effects;
- ambiguous naming;
- sensitive fields;
- excessively broad outputs;
- unsupported authentication;
- prompt injection;
- cross-origin behavior;
- destructive actions;
- unsafe retry behavior.

### Verification Planner

Produces a deterministic test plan for each approved capability.

### WebMCP Compiler

Converts approved CapabilityIR into:

- runtime code;
- tool definitions;
- adapters;
- tests;
- manifest;
- installation package.

## 11.13 Step A11 — Capability proposal

Example proposal:

```text
create_support_ticket

Create a support ticket for an order available to the signed-in user.

Inputs:
- orderId: string
- title: string, 3–120 characters
- priority: low | medium | high

Execution:
POST /api/tickets

Authentication:
Existing same-origin browser session

CSRF:
Dynamic token from approved page source

Effects:
Creates one support ticket
May trigger an internal support notification

Success:
HTTP 201
Matching ticket row appears in the UI

Risk:
R1 — reversible low-risk mutation

Output:
ticketId, status, priority, createdAt
```

## 11.14 Step A12 — Authentication classification

Possible classifications:

- public;
- same-origin `HttpOnly` session cookie;
- same-origin readable cookie;
- same-origin session plus CSRF token;
- browser-held bearer token;
- browser-safe OAuth with PKCE;
- cross-origin credentialed session;
- server-held secret;
- unsupported.

Preferred result:

```text
Same-origin HttpOnly session cookie
```

A same-origin fetch sends credentials by default. An `HttpOnly` cookie is inaccessible to JavaScript but is still sent with qualifying JavaScript-initiated requests. This allows generated tools to reuse a browser session without extracting the cookie value.

Blocked or restricted cases:

- client secret required in browser;
- token must be copied to Page2WebMCP;
- unknown CSRF behavior;
- cross-origin cookie behavior cannot be reproduced;
- authorization appears to rely only on hidden UI state;
- a long-lived bearer token would need to be embedded in the bundle.

## 11.15 Step A13 — Execution strategy selection

### Strategy A: Application API bridge

Preferred.

```text
WebMCP tool
→ validate input
→ same-origin API request
→ existing session
→ existing server authorization
→ project response
→ update or refresh UI
```

Production eligibility:

- stable same-origin endpoint;
- safe authentication;
- explicit input mapping;
- explicit output projection;
- deterministic success signal;
- replay passed.

### Strategy B: Standard form bridge

```text
WebMCP tool
→ locate approved form
→ fill typed fields
→ invoke existing submit behavior
→ await success state
```

Production eligibility:

- standard semantic form;
- stable field identity;
- low-risk capability;
- deterministic success state;
- no hidden consequential side effects.

### Strategy C: Semantic UI bridge

```text
WebMCP tool
→ locate element by role, accessible name, route, and context
→ perform action
→ assert state transition
```

This strategy is limited to simple, low-risk interactions.

It should normally receive **Verified** rather than **Production-ready** status unless repeated stability tests pass.

### Strategy D: Server adapter

Used when:

- an API key is required;
- a client credential is required;
- cross-origin behavior needs controlled mediation;
- CORS prevents direct browser calls.

The secret is configured in the customer’s Vercel or Render environment, not in Page2WebMCP’s generated browser bundle.

### Strategy E: Source hardening required

The workflow is understood but cannot safely be reproduced.

The product offers:

```text
[Connect GitHub to harden]
```

## 11.16 Step A14 — User review

The user reviews:

- tool name;
- title;
- description;
- source evidence;
- input schema;
- authentication strategy;
- side effects;
- output fields;
- risk;
- confirmation policy;
- retry policy;
- verification plan.

Actions:

- approve;
- edit;
- reject;
- require confirmation;
- remove a field;
- reduce output;
- require GitHub hardening;
- mark experimental;
- block from production.

## 11.17 Step A15 — Autonomous mutation verification

Read tools may be verified automatically.

Mutation candidates require explicit approval.

Example:

```text
Page2WebMCP found three state-changing capabilities.

Proposed validation:

1. Create one support ticket with a unique TEST marker.
2. Verify the ticket appears.
3. Change its priority once.
4. Remove it only if a safe cleanup action is available.

The test will not:
- contact a customer
- alter an order
- access billing
- delete existing data

[Reject] [Approve test]
```

After approval, the request firewall permits only the exact expected mutation shape.

Everything else remains blocked.

## 11.18 Step A16 — URL-path release output

The independent URL path produces:

- `CapabilityIR`;
- WebMCP registration bundle;
- API, form, or semantic bridge;
- internal output contract;
- deterministic tests;
- agent-selection evals;
- security report;
- compatibility report;
- installation instructions;
- version manifest;
- integrity hash;
- unsupported-capability report.

A repository is not required.

---

# 12. Path B — OpenAPI: Contract Compilation

## 12.1 User promise

> Paste an OpenAPI URL or upload a specification. Page2WebMCP turns API operations into safe, user-oriented WebMCP tools.

The current latest published OpenAPI specification is version 3.2.0. OpenAPI is expressly designed to describe HTTP APIs in a language-independent format without requiring access to source code or runtime traffic.

## 12.2 Supported formats

- OpenAPI 3.0.x;
- OpenAPI 3.1.x;
- OpenAPI 3.2.x;
- JSON;
- YAML;
- local references;
- same-document references;
- REST JSON requests and responses;
- API key;
- HTTP bearer;
- cookie authentication;
- OAuth 2.0;
- OpenID Connect.

Unsupported for production compilation in 72 hours:

- Swagger 2.0 without explicit conversion;
- arbitrary external references;
- callbacks;
- webhooks;
- streaming;
- WebSockets;
- multipart upload;
- mutual TLS;
- highly recursive or ambiguous schemas.

## 12.3 Step B1 — Import

Input options:

```text
https://api.example.com/openapi.json
```

or file upload.

Controls:

- document-size limit;
- YAML safe parser;
- reference-depth limit;
- cycle detection;
- external references disabled by default;
- SSRF validation for fetched references;
- script and HTML sanitization in descriptions;
- content hash.

## 12.4 Step B2 — Specification validation

The product reports:

- OpenAPI version;
- parser errors;
- unresolved references;
- duplicate operation IDs;
- missing operation summaries;
- missing response schemas;
- undocumented security;
- ambiguous server definitions;
- destructive operations;
- incompatible browser authentication.

A malformed specification may produce a report, but not a production-ready release.

## 12.5 Step B3 — Operation discovery

Page2WebMCP extracts:

- paths;
- methods;
- operation IDs;
- tags;
- summaries;
- request parameters;
- request bodies;
- response schemas;
- security schemes;
- required scopes;
- examples;
- errors;
- deprecations.

## 12.6 Step B4 — Operation grouping

Page2WebMCP must not produce one tool for every operation.

Example source operations:

```text
GET /orders/{id}
GET /orders/{id}/shipment
GET /orders/{id}/events
```

Possible generated capability:

```text
get_order_status
```

The user sees which operations support the capability.

## 12.7 Step B5 — Authentication strategy

### Public API

Generate a browser tool directly.

### Same-origin cookie API

Generate a same-origin browser adapter.

### OAuth Authorization Code with PKCE

Generate a browser-safe user-bound authorization flow.

### API key

Generate a server adapter.

Never embed the key in the browser bundle.

### Client credentials

Generate a server adapter.

The generated deployment expects:

```text
TARGET_CLIENT_ID
TARGET_CLIENT_SECRET
```

### User-supplied bearer token for testing

Hold in ephemeral process memory only.

Do not write it to:

- Postgres;
- object storage;
- workflow snapshots;
- model prompts;
- logs;
- generated code.

## 12.8 Step B6 — Capability review

For each generated capability, show:

- source operations;
- tool name and title;
- input schema;
- required scopes;
- authentication mode;
- read/write classification;
- request fields;
- output fields;
- documented errors;
- likely side effects;
- confirmation requirement;
- server-adapter requirement.

Operations such as the following are disabled by default:

- `DELETE`;
- privilege changes;
- password operations;
- payment operations;
- account security;
- bulk export;
- administrator management.

## 12.9 Step B7 — Live validation

The user may provide:

- a test API base URL;
- a staging environment;
- a test account;
- ephemeral test credentials.

Required checks:

- path serialization;
- query encoding;
- request-body validation;
- authentication failure;
- authorization failure;
- success response;
- error mapping;
- response projection;
- rate-limit behavior;
- no secret in browser artifacts.

## 12.10 Step B8 — OpenAPI output

Depending on authentication, generate:

### Browser-only package

For:

- public APIs;
- same-origin cookies;
- browser-safe OAuth.

### Browser bundle plus server adapter

For:

- API keys;
- client credentials;
- server-held secrets;
- controlled cross-origin mediation.

### GitHub pull request

When a repository is subsequently connected.

The OpenAPI path must independently produce an installable, working WebMCP layer.

---

# 13. Path C — GitHub: Source Hardening

## 13.1 User promise

> Connect a Next.js repository and receive a tested pull request that adds a source-native WebMCP layer.

## 13.2 Why this path exists

The GitHub path increases assurance by confirming:

- actual application semantics;
- authentication implementation;
- authorization implementation;
- validation schemas;
- service-layer behavior;
- data projections;
- secondary side effects;
- correct installation location.

It can begin independently from source or harden a capability first discovered from URL or OpenAPI evidence.

## 13.3 Supported MVP envelope

- GitHub;
- selected repository installation;
- Next.js App Router;
- TypeScript;
- Route Handlers;
- Server Actions and Server Functions;
- React forms;
- `fetch`;
- Zod;
- common Auth.js patterns;
- common Supabase SSR patterns;
- Prisma;
- Drizzle;
- Supabase data access;
- npm, pnpm, or Bun detection.

Not supported:

- arbitrary frameworks;
- complex multi-application monorepos;
- private package infrastructure;
- builds requiring production secrets;
- repositories that cannot be analyzed without executing untrusted install scripts.

## 13.4 GitHub App permissions

Required:

```text
Metadata: read
Contents: read and write
Pull requests: read and write
```

Optional:

```text
Checks: read
Commit statuses: read
```

Not requested:

```text
Secrets
Administration
Members
Actions: write
Workflows: write
```

GitHub Apps should request minimum permissions. Installation access tokens expire after one hour and can be restricted to selected repositories.

## 13.5 Step C1 — Repository preflight

Detect:

- application root;
- package manager;
- Next.js version and structure;
- TypeScript configuration;
- build command;
- existing WebMCP code;
- routes;
- forms;
- Server Actions;
- validation libraries;
- auth helpers;
- authorization helpers;
- services;
- database layer;
- existing tests;
- OpenAPI documents;
- Vercel configuration.

## 13.6 Step C2 — Safe repository analysis

Repository processing occurs in a disposable environment.

Rules:

- shallow checkout;
- no customer production secrets;
- no Page2WebMCP control-plane secret;
- static AST analysis first;
- no install scripts during first pass;
- restricted egress;
- CPU, memory, and time limits;
- temporary filesystem;
- repository text treated as untrusted;
- only necessary source slices sent to the LLM;
- generated changes restricted to approved paths.

## 13.7 Step C3 — Source capability graph

The analyzer connects:

```text
Visible UI
→ form or interaction
→ client call
→ Route Handler or Server Action
→ authentication
→ authorization
→ input validation
→ application service
→ side effect
→ output
→ UI refresh
```

Example:

```text
Capability:
create_support_ticket

UI:
app/orders/[id]/TicketForm.tsx

Validation:
CreateTicketSchema

Execution:
app/orders/[id]/actions.ts:createTicket

Authentication:
requireUser()

Authorization:
requireOrderAccess(user.id, orderId)

Service:
ticketService.create()

Effects:
Creates a ticket
May notify internal support
Revalidates the order page

Output:
ticket ID, status, priority
```

Next.js explicitly recommends treating Route Handlers and Server Actions as public-facing endpoints and performing authentication and authorization within those operations rather than relying on hidden UI controls.

## 13.8 Step C4 — Generation priority

1. reuse an existing secured Route Handler;
2. call an existing browser-safe service;
3. create a narrow Route Handler around an existing application service;
4. preserve existing authentication and authorization helpers;
5. reject generation when authorization cannot be preserved.

Generated wrappers must:

- authenticate;
- authorize;
- validate inputs;
- allowlist fields;
- project outputs;
- use existing services;
- avoid direct database access when a service exists;
- preserve CSRF or same-origin checks;
- avoid returning internal errors;
- avoid returning sensitive fields.

## 13.9 Step C5 — Generated files

```text
app/
  _page2webmcp/
    WebMCPProvider.tsx
    capabilities.generated.ts
    register.generated.ts
    runtime/
      confirmation.ts
      errors.ts
      csrf.ts
      origin-lock.ts
      output-projection.ts
    page2webmcp.manifest.json
    README.md

app/
  api/
    page2webmcp/
      create-support-ticket/
        route.ts

tests/
  page2webmcp/
    tools.test.ts
    authorization.test.ts
    evals.json

docs/
  page2webmcp-security.md
```

## 13.10 Step C6 — Pull request

The PR includes:

- tools added;
- source evidence;
- services reused;
- authorization path;
- new API surface;
- risk classification;
- tests;
- unsupported capabilities;
- installation details;
- rollback details;
- generated-file notice.

Example PR summary:

```markdown
## Added WebMCP tools

- find_order
- get_order_status
- create_support_ticket

## Existing application logic reused

- orderService.search()
- orderService.getStatus()
- ticketService.create()

## Security

- Existing session verification preserved
- Existing order authorization preserved
- No credentials added
- No direct database access added
- Cross-origin tool exposure disabled

## Verification

- Typecheck: passed
- Build: passed
- Deterministic tool tests: 9/9
- Authorization tests: 4/4
- Agent-selection evals: 19/20
```

## 13.11 Step C7 — Preview verification

If the repository is connected to Vercel, a pull request can produce a preview deployment without changing production. Vercel maintains separate Local, Preview, and Production environments and creates preview deployments from non-production branches and pull requests.

Page2WebMCP tests the preview in Chrome:

- tools registered;
- direct invocation passed;
- natural-language selection passed;
- UI updated;
- logged-out call failed;
- production origin remains unchanged.

---

# 14. Evidence Fusion

Each source is independently usable.

Combining sources raises assurance.

## 14.1 URL only

```text
✓ Runtime workflow observed
✓ Authentication behavior observed
✓ Request shape observed
✓ State change replayed
? API contract undocumented
? Source authorization not confirmed
```

## 14.2 OpenAPI only

```text
✓ API contract confirmed
✓ Input schema confirmed
✓ Security scheme confirmed
✓ Documented responses confirmed
? Live UI relationship unknown
? Source authorization not confirmed
```

## 14.3 GitHub only

```text
✓ Application logic confirmed
✓ Authorization path confirmed
✓ Validation confirmed
✓ Build and tests confirmed
? Runtime user journey not independently observed
```

## 14.4 All sources

```text
✓ User workflow observed
✓ Runtime API behavior observed
✓ Contract confirmed
✓ Authorization implementation confirmed
✓ Source-native implementation generated
✓ Build passed
✓ Replay passed
✓ Agent eval passed
```

## 14.5 Conflict handling

Page2WebMCP blocks silent reconciliation.

Examples:

- runtime sends a field absent from OpenAPI;
- OpenAPI describes a read but runtime changes state;
- source requires a permission absent from the contract;
- UI displays fewer fields than the source response returns;
- runtime calls a different endpoint from the documented operation;
- source indicates a secondary side effect absent from the UI.

Result:

```text
Blocked: evidence conflict
```

The user must resolve or explicitly choose the authoritative source.

---

# 15. Capability Intermediate Representation

All paths compile to a shared model.

```ts
type CapabilityIR = {
  id: string;
  projectId: string;
  version: number;

  identity: {
    name: string;
    title: string;
    description: string;
  };

  schemas: {
    input: JsonSchema;
    outputContract?: JsonSchema;
  };

  evidence: Array<{
    source: "runtime" | "openapi" | "github";
    reference: string;
    artifactId?: string;
    confidence: "direct" | "inferred";
  }>;

  authentication: {
    mode:
      | "public"
      | "same_origin_cookie"
      | "oauth_pkce"
      | "browser_token"
      | "server_secret"
      | "unsupported";
    csrf?: {
      required: boolean;
      resolver?: CsrfResolver;
    };
    requiredScopes?: string[];
  };

  authorization: {
    status:
      | "source_confirmed"
      | "runtime_observed"
      | "owner_attested"
      | "unknown";
    references?: string[];
  };

  execution: {
    strategy:
      | "app_native"
      | "same_origin_fetch"
      | "form_bridge"
      | "semantic_ui"
      | "server_adapter";
    target: string;
    requestTemplate?: RequestTemplate;
    timeoutMs: number;
    retryPolicy: RetryPolicy;
    preconditions: Assertion[];
    postconditions: Assertion[];
  };

  safety: {
    riskTier: "R0" | "R1" | "R2" | "R3";
    readOnly: boolean;
    untrustedOutput: boolean;
    confirmation:
      | "none"
      | "first_in_session"
      | "always"
      | "blocked";
    allowedInputFields: string[];
    outputProjection: string[];
  };

  reliability: {
    idempotency: "none" | "native" | "generated";
    driftFingerprint: string;
    replayPassesRequired: number;
  };

  status:
    | "discovered"
    | "proposed"
    | "reviewed"
    | "verified"
    | "production_ready"
    | "blocked";
};
```

`outputContract`, risk tier, retry policy, confirmation policy, and drift metadata are Page2WebMCP concepts.

They must not be emitted as invented WebMCP-standard properties.

The current WebMCP tool definition standardizes an input schema but does not define a standardized output schema. Page2WebMCP therefore uses its output contract for testing and projection while returning a normal tool result at runtime.

---

# 16. Generated WebMCP Runtime

## 16.1 Canonical registration

```ts
"use client";

const controllers = new Map<string, AbortController>();

export async function registerPage2WebMCPTools() {
  if (!document.modelContext) {
    return {
      supported: false,
      reason: "WEBMCP_UNAVAILABLE"
    };
  }

  const controller = new AbortController();
  controllers.set("create_support_ticket", controller);

  await document.modelContext.registerTool(
    {
      name: "create_support_ticket",
      title: "Create support ticket",
      description:
        "Create a support ticket for an order available to the signed-in user.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["orderId", "title", "priority"],
        properties: {
          orderId: {
            type: "string",
            minLength: 1,
            maxLength: 80
          },
          title: {
            type: "string",
            minLength: 3,
            maxLength: 120
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"]
          }
        }
      },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: false
      },
      execute: async (input, { signal }) => {
        return executeCreateSupportTicket(input, { signal });
      }
    },
    {
      signal: controller.signal
      // exposedTo intentionally omitted.
    }
  );

  return { supported: true };
}

export function unregisterPage2WebMCPTool(name: string) {
  controllers.get(name)?.abort();
  controllers.delete(name);
}
```

The specification supports tool cancellation, tool unregistration through an abort signal, explicit cross-origin exposure through `exposedTo`, and cancellation of active execution. Page2WebMCP omits `exposedTo` by default so tools remain same-origin.

## 16.2 Tool execution

```ts
async function executeCreateSupportTicket(
  input: CreateSupportTicketInput,
  context: { signal: AbortSignal }
) {
  validateCreateSupportTicketInput(input);

  await requirePage2WebMCPConfirmation({
    capability: "create_support_ticket",
    summary: `Create a ${input.priority} priority support ticket?`
  });

  const csrf = resolveApprovedCsrfToken();

  const response = await fetch("/api/tickets", {
    method: "POST",
    credentials: "same-origin",
    signal: context.signal,
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {})
    },
    body: JSON.stringify({
      orderId: input.orderId,
      title: input.title,
      priority: input.priority
    })
  });

  if (!response.ok) {
    throw await mapToolError(response);
  }

  const raw = await response.json();

  return {
    success: true,
    ticketId: raw.id,
    status: raw.status,
    priority: raw.priority,
    createdAt: raw.createdAt
  };
}
```

## 16.3 Dynamic availability

Capabilities may be registered based on:

- route;
- authentication state;
- selected workspace;
- current entity;
- feature flag;
- permission.

Registration and unregistration should follow application state to reduce irrelevant tool choices.

## 16.4 Runtime invariants

The generated runtime:

- contains no target credential;
- contains no Page2WebMCP API key;
- contains no `eval`;
- refuses unapproved origins;
- applies strict input validation;
- applies output projection;
- omits cross-origin exposure;
- propagates cancellation;
- uses typed errors;
- performs no hidden calls to Page2WebMCP;
- emits no telemetry unless explicitly enabled.

---

# 17. Generated Artifact Structure

```text
page2webmcp/
  manifest.json
  capability-report.json
  security-report.json
  compatibility-report.json
  integrity.json
  INSTALL.md
  SECURITY.md

  src/
    index.ts
    register.ts

    runtime/
      confirmation.ts
      csrf.ts
      errors.ts
      origin-lock.ts
      assertions.ts
      output-projection.ts
      drift.ts

    tools/
      find-order.ts
      get-order-status.ts
      create-support-ticket.ts

  tests/
    contract/
      find-order.test.ts
      create-support-ticket.test.ts

    browser/
      registration.spec.ts
      create-support-ticket.spec.ts

    evals/
      direct.json
      ambiguous.json
      negative.json
      multi-step.json
      injection.json
```

## 17.1 Manifest

```json
{
  "format": "page2webmcp/1",
  "projectId": "project_123",
  "version": "1.0.0",
  "allowedOrigins": [
    "https://support.example.com"
  ],
  "webmcpCompatibility": {
    "specificationDate": "2026-08-26",
    "api": "imperative",
    "chromeMinimum": 149
  },
  "capabilities": [
    "find_order",
    "get_order_status",
    "create_support_ticket"
  ],
  "contentHash": "sha256-...",
  "subresourceIntegrity": "sha384-..."
}
```

---

# 18. Installation

## 18.1 Self-hosted bundle — recommended

The user hosts the generated code under their own origin.

```html
<script
  type="module"
  src="/page2webmcp/v1/index.js">
</script>
```

Benefits:

- first-party runtime;
- simplest trust model;
- no external runtime availability dependency;
- easiest CSP policy;
- direct source review.

## 18.2 Immutable managed bundle

```html
<script
  type="module"
  src="https://cdn.page2webmcp.dev/project/version/hash.js"
  integrity="sha384-..."
  crossorigin="anonymous">
</script>
```

Requirements:

- immutable;
- content-addressed;
- origin-locked;
- Subresource Integrity;
- long-lived cache;
- no dynamic code loading;
- no credential collection;
- no runtime control-plane request.

## 18.3 GitHub pull request

Recommended for source-connected applications.

The PR installs:

- provider;
- runtime;
- application adapters;
- tests;
- documentation.

## 18.4 Server adapter deployment

For server-held API credentials:

- Vercel project;
- Render web service;
- existing customer backend.

The user configures secrets in their own environment.

Vercel environment variables are configured outside source and scoped to deployment environments; changes apply to new deployments.

## 18.5 Compatibility preflight

Before publishing:

- HTTPS confirmed;
- origin verified;
- origin isolation compatible;
- `document.domain` not enabled;
- `tools` permission not disabled;
- CSP compatible;
- WebMCP feature detection passed;
- no duplicate registration;
- Chrome 149 or ChatGPT browser test passed.

---

# 19. Security Model

## 19.1 Security invariants

1. Page2WebMCP never persists a target-site password.
2. Page2WebMCP never persists raw session cookies.
3. Page2WebMCP never embeds a server secret in browser code.
4. Authenticated scanning requires verified ownership.
5. Every bundle is origin-locked.
6. Cross-origin exposure is disabled by default.
7. Every capability has an explicit effect classification.
8. Every mutation requires a defined confirmation policy.
9. High-risk capabilities are blocked.
10. The LLM cannot directly publish.
11. Production runtime has no required Page2WebMCP backchannel.
12. Unknown authentication fails closed.
13. Unknown authorization fails closed.
14. Generated output is minimized.
15. Every release is versioned and rollbackable.

## 19.2 Trust boundaries

```text
User
  │
  ▼
Page2WebMCP Control Plane
  │
  ├── Project metadata
  ├── Sanitized evidence
  └── Approval and releases
  │
  ▼
Ephemeral Browser Use Session
  │
  ├── User enters credentials
  ├── Authenticated browser state
  └── Destroyed after scan
  │
  ▼
CDP Sanitization Boundary
  │
  ├── Removes credential values
  ├── Redacts sensitive fields
  └── Produces typed evidence
  │
  ▼
Mastra Agents and LLMs
  │
  ├── Interpret sanitized evidence
  └── Cannot directly publish
  │
  ▼
Deterministic Compiler and Tests
  │
  ▼
Generated Customer Runtime
  │
  ├── Executes inside customer origin
  ├── Uses existing session
  └── No Page2WebMCP dependency
```

## 19.3 Threat model

| Threat | Impact | Required mitigation |
|---|---|---|
| SSRF through submitted URL | Access to internal networks | Public-IP validation, redirect validation, DNS revalidation, network egress controls |
| Credential leakage | Account compromise | Ephemeral browser, header redaction, no cookie persistence, secret canaries |
| Live-view URL leakage | Session takeover | Encrypt, never log, short retention, revoke session |
| Prompt injection in webpage | Explorer manipulation | Treat page as untrusted, deterministic firewall, constrained extraction, critic |
| Prompt injection in OpenAPI | Malicious descriptions | Sanitize CommonMark, typed extraction, do not execute document instructions |
| Prompt injection in repository | Agent follows malicious comments | Treat repo text as untrusted data, restrict generator, owner review |
| Misleading tool description | Unintended effect | Compare description against evidence and observed behavior |
| Contaminated output | Agent hijacking | Minimal projection and `untrustedContentHint` |
| Cross-origin exfiltration | Private-data leakage | Origin allowlist, omit `exposedTo`, request firewall |
| Broken authorization | Unauthorized resource access | Preserve server checks, logged-out and forbidden tests |
| Mass assignment | Protected field modification | `additionalProperties: false`, input allowlist |
| CSRF | Unauthorized or failed mutation | Reuse current CSRF mechanism, same-origin checks, block unknown strategy |
| Duplicate mutation | Duplicate records | No mutation retry without idempotency |
| Supply-chain compromise | Malicious generated script | Self-host option, immutable bundle, SRI, hashes |
| Repository build attack | Worker compromise | Sandbox, no secrets, no install scripts first pass, restricted egress |
| Multi-tenant leak | Customer data disclosure | RLS, tenant-scoped queries, isolation tests |
| Drift | Silent breakage | Fingerprints, health tests, disable or regenerate |
| High-risk business action | Financial or security harm | Risk tiers and prohibition policy |

Chrome warns that WebMCP agents operate inside authenticated browser sessions and that malicious tool metadata, contaminated outputs, and indirect prompt injection require deterministic guardrails, origin restrictions, user confirmation, token limits, critics, and explicit handling of untrusted content.

## 19.4 Risk tiers

### R0 — Read-only

Examples:

- search;
- list resources;
- retrieve status;
- calculate a summary.

Requirements:

- `readOnlyHint: true`;
- minimal output;
- authorization tests;
- no mutation confirmation.

### R1 — Low-risk reversible mutation

Examples:

- create an internal ticket;
- update a task title;
- add an item to a draft list.

Requirements:

- explicit effects;
- confirmation before first mutation in session;
- idempotency analysis;
- deterministic postcondition;
- owner-approved validation.

### R2 — Consequential action

Examples:

- publish content;
- send a message to a customer;
- cancel a reservation;
- submit an application.

Hackathon policy:

- not production-ready from URL-only evidence;
- OpenAPI or source evidence required;
- confirmation every time;
- explicit owner opt-in;
- not used in the main demo.

### R3 — Prohibited automatic generation

Examples:

- purchase;
- payment;
- transfer;
- password reset;
- authentication changes;
- permission changes;
- administrator invitation;
- account deletion;
- bulk sensitive export;
- regulated medical or legal decision.

Output:

```text
Capability report only
No executable WebMCP tool generated
```

## 19.5 Prompt-injection defenses

- All page text is untrusted.
- All OpenAPI descriptions are untrusted.
- All repository comments and documentation are untrusted.
- Tool descriptions are generated from structured evidence rather than copied wholesale.
- Hidden DOM text is excluded from semantic descriptions.
- Untrusted content is delimited or otherwise spotlighted before model processing.
- Security Critic is isolated from unnecessary raw page content.
- Tool outputs containing user or third-party content receive `untrustedContentHint: true`.
- Adversarial evals test tool poisoning, output injection, and data exfiltration.
- No agent is allowed to publish autonomously.

## 19.6 Credential strategy by path

| Path | Authentication treatment |
|---|---|
| Website URL | User authenticates inside ephemeral browser; generated tool reuses existing browser session |
| OpenAPI cookie | Same-origin browser adapter |
| OpenAPI OAuth PKCE | User-bound browser authorization |
| OpenAPI API key | Customer-owned server adapter |
| OpenAPI client credentials | Customer-owned server adapter |
| GitHub | Short-lived installation access token |
| Generated runtime | No Page2WebMCP or target secret embedded |

## 19.7 Data retention

Proposed defaults:

| Data | Retention |
|---|---|
| Password | Never collected |
| Raw cookie | Never persisted |
| Authorization header | Never persisted |
| Browser local storage | Session only |
| Raw request/response body | In memory until sanitization |
| Browser live-view URL | Until session terminates |
| Browser CDP URL | Until session terminates |
| Authenticated screenshots | Off by default |
| Recording | Off by default |
| Sanitized evidence | Seven days |
| Generated artifacts | Until project deletion |
| Audit log | Thirty days |
| Runtime tool inputs | Not collected by default |
| Runtime tool outputs | Not collected by default |

---

# 20. Multi-Tenant Security

Supabase stores users, projects, evidence metadata, capabilities, tests, and releases.

Every exposed table must have:

- RLS enabled;
- grants reduced to necessary operations;
- separate policies for select, insert, update, and delete;
- organization membership checks;
- negative tenant-isolation tests.

Supabase recommends enabling RLS on every exposed table, limiting grants, testing policies, and never exposing service-role or secret credentials in the browser because those credentials bypass RLS.

Proposed policy model:

```text
Organization Owner
- manage project
- connect sources
- approve and publish
- delete project

Editor
- run scans
- edit capabilities
- run tests
- create candidate releases

Viewer
- read project
- inspect evidence
- inspect tests
```

The worker uses a separate server-side identity and only handles jobs for the claimed project.

---

# 21. Reliability and Verification

## 21.1 Test categories

### Schema tests

- valid input accepted;
- invalid input rejected;
- unknown fields rejected;
- size limits enforced;
- enum constraints enforced.

### Authentication tests

- logged-out request rejected;
- invalid session rejected;
- correct session succeeds;
- forbidden resource rejected where fixtures exist.

### Execution tests

- expected API or form invoked;
- only allowed fields sent;
- expected response received;
- expected UI state observed;
- output projection matches contract.

### Retry tests

- read retries only temporary failures;
- mutations do not retry without idempotency;
- rate limits are respected;
- cancellation stops the active request.

### Security tests

- credential canary does not enter evidence;
- credential canary does not enter model prompt;
- credential canary does not enter bundle;
- cross-origin navigation blocked;
- prompt-injection fixture rejected or neutralized;
- high-risk operation blocked.

### Agent-selection evals

- direct prompts;
- ambiguous prompts;
- negative prompts;
- similar-tool disambiguation;
- multi-step workflows;
- mid-chain failures;
- malicious prompts.

Chrome recommends both deterministic tests and probabilistic evals, including direct tool execution with `document.modelContext.executeTool()`, isolated tool selection tests, and end-to-end multi-tool journeys.

## 21.2 Verification thresholds

Hackathon thresholds:

```text
Contract tests:             100%
Replay:                     3/3 passes
Logged-out negative test:   pass
Secret leakage:             zero
High-severity findings:     zero
Direct Chrome execution:    pass
Tool-selection eval:        ≥18/20
Negative false positives:   ≤1/10
Owner approval:             required
Installation smoke test:    pass
```

## 21.3 Chrome Verification Lab

The Verification Lab shows:

### Registration

- registered tool list;
- names;
- descriptions;
- schemas;
- annotations;
- active origin.

### Direct execution

Calls:

```ts
document.modelContext.executeTool(...)
```

### Natural-language evaluation

Prompts a model to select the correct tool and arguments.

### UI state

Verifies that application state reflects the result.

### Lighthouse

Chrome’s Lighthouse audit can list registered imperative and declarative WebMCP tools, providing another verification signal.

## 21.4 Error taxonomy

```text
AUTH_REQUIRED
FORBIDDEN
VALIDATION_ERROR
NOT_FOUND
CONFLICT
CONFIRMATION_DECLINED
RATE_LIMITED
TEMPORARY_UPSTREAM
TIMEOUT
CANCELLED
UNSUPPORTED_STATE
DRIFT_DETECTED
INTEGRATION_DISABLED
INTERNAL_ERROR
```

Each error tells the calling agent whether:

- the user must act;
- input should change;
- action is forbidden;
- retry is safe;
- the integration must be regenerated.

## 21.5 Retry policy

### Read operations

- maximum two retries;
- exponential backoff;
- jitter;
- temporary failures only;
- respect rate-limit responses.

### Mutations

- no retry by default;
- retry only with native or generated idempotency;
- never retry validation, authorization, or conflict errors.

## 21.6 Timeouts and cancellation

- default timeout: 15 seconds;
- capability-specific overrides;
- propagate the WebMCP `AbortSignal`;
- cancel pending fetch;
- clean up loading states;
- return typed cancellation.

## 21.7 Drift detection

Fingerprint:

- route;
- form structure;
- labels;
- request shape;
- response shape;
- OpenAPI hash;
- source commit;
- generated version.

On drift:

1. mark capability unhealthy;
2. prevent unsafe automatic execution where appropriate;
3. create a regeneration candidate;
4. rerun verification;
5. require approval;
6. publish a new immutable version.

---

# 22. System Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                 Page2WebMCP Control Plane                   │
│                   Next.js on Vercel                         │
│                                                             │
│ Auth │ Projects │ Review │ Verification │ Releases │ Audit │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         Supabase                            │
│                                                             │
│ Auth │ Postgres + RLS │ Storage │ Queues │ Audit           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Render Worker / Mastra                    │
│                                                             │
│ Durable workflow │ Agents │ Sanitizer │ Compiler │ Tests   │
└──────────────┬───────────────┬───────────────┬──────────────┘
               │               │               │
               ▼               ▼               ▼
      Browser Use Cloud     GitHub App      Model providers
      Live browser          Source access   Sanitized input
      CDP endpoint          Draft PR        Structured output
               │
               ▼
      Playwright/CDP Observer
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Artifact Publisher                       │
│                                                             │
│ Bundle │ Server adapter │ Security report │ GitHub PR       │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Customer Application                     │
│                                                             │
│ document.modelContext → Existing auth → Existing app logic │
│                                                             │
│             Chrome / ChatGPT browser agent                 │
└─────────────────────────────────────────────────────────────┘
```

## 22.1 Vercel

Responsibilities:

- Next.js application;
- authentication callbacks;
- project dashboard;
- review UI;
- verification UI;
- public demo;
- static artifact delivery;
- GitHub preview integration.

## 22.2 Supabase

Responsibilities:

- user authentication;
- organizations;
- projects;
- source metadata;
- capabilities;
- releases;
- RLS;
- queue;
- audit log;
- generated artifact metadata.

Supabase Queues provides a Postgres-native durable queue with guaranteed delivery and RLS integration, making it suitable for dispatching long-running scan and generation jobs.

## 22.3 Render worker

Responsibilities:

- consume jobs;
- run long browser scans;
- connect Playwright;
- parse OpenAPI;
- analyze repositories;
- run Mastra workflows;
- compile artifacts;
- execute tests;
- publish results.

Render background workers are designed for continuously running processes that consume asynchronous jobs outside the public request path.

## 22.4 Mastra

Responsibilities:

- typed workflow graph;
- agent orchestration;
- suspension for authentication;
- suspension for mutation approval;
- durable state;
- branching;
- parallel evidence analysis;
- retries;
- observability.

Mastra workflows support explicit sequential, parallel, branching, and looping control flow as well as suspension, resumption, and persisted state. Mastra can use PostgreSQL-backed workflow storage, allowing Supabase Postgres to persist workflow snapshots.

## 22.5 Browser Use

Responsibilities:

- isolated browser;
- live view;
- human authentication handoff;
- autonomous navigation;
- session continuation;
- structured task output;
- CDP endpoint.

Browser Use is compile-time infrastructure only.

It is not part of production tool execution.

## 22.6 Playwright/CDP

Responsibilities:

- deterministic DOM observation;
- accessibility evidence;
- network shapes;
- request firewall;
- state diffs;
- success assertions;
- Chrome registration test.

## 22.7 LLMs

Use at compile time for:

- page and capability interpretation;
- operation grouping;
- naming;
- descriptions;
- schema proposals;
- effect summaries;
- security critique;
- eval generation.

Do not use an LLM for:

- request interception;
- credential redaction;
- input validation;
- output projection;
- publication authorization;
- origin enforcement;
- test pass/fail determination where deterministic checks exist.

---

# 23. Mastra Workflow

```text
createProject
  → classifyInput
  → verifyOriginOrContract
  → createSource
  → branch:
      ├── runWebsitePath
      ├── runOpenAPIPath
      └── runGitHubPath
  → normalizeCapabilityEvidence
  → synthesizeCapabilities
  → runSecurityCritic
  → persistCandidates
  → suspendForOwnerReview
  → planVerification
  → suspendForMutationApprovalIfNeeded
  → runDeterministicVerification
  → runAgentSelectionEvals
  → compileCandidateRelease
  → runArtifactSecurityChecks
  → suspendForPublishApproval
  → publishRelease
```

## 23.1 Website subworkflow

```text
safeUrlPreflight
→ verifyDomain
→ createBrowserUseSession
→ navigateToApplication
→ suspendForAuthentication
→ verifyAuthenticatedState
→ attachCDPObserver
→ runReadOnlyExplorer
→ sanitizeEvidence
→ parallel:
    ├── mapApplication
    ├── analyzeProtocols
    └── analyzeSecurity
→ synthesizeRuntimeCapabilities
→ stopBrowserIfNoValidationNeeded
```

## 23.2 OpenAPI subworkflow

```text
fetchSpecification
→ validateSpecification
→ resolveSafeReferences
→ extractOperations
→ classifyAuthentication
→ groupOperations
→ synthesizeCapabilities
→ generateAdapterPlan
```

## 23.3 GitHub subworkflow

```text
mintInstallationToken
→ fetchRepository
→ detectNextjsStructure
→ runStaticAnalysis
→ mapCapabilities
→ generateChange
→ createBranch
→ commitGeneratedFiles
→ openDraftPullRequest
→ observeCIAndPreview
```

---

# 24. Data Model

## Organization

```text
id
name
created_at
```

## Membership

```text
organization_id
user_id
role
```

## Project

```text
id
organization_id
name
primary_origin
status
created_at
deleted_at
```

## DomainVerification

```text
project_id
origin
method
challenge_hash
verified_at
expires_at
```

## Source

```text
id
project_id
type: url | openapi | github
status
configuration_encrypted
content_hash
created_at
```

## Job

```text
id
project_id
source_id
workflow_run_id
status
attempt
started_at
completed_at
error_code
```

## BrowserSession

```text
job_id
provider_session_id_encrypted
live_url_encrypted
cdp_url_encrypted
expires_at
destroyed_at
```

No cookies or browser storage values.

## Evidence

```text
id
project_id
source_id
kind
sanitized_payload
content_hash
retention_until
```

## Capability

```text
id
project_id
stable_name
current_version_id
status
```

## CapabilityVersion

```text
id
capability_id
ir
risk_tier
execution_strategy
approved_by
approved_at
created_at
```

## TestCase

```text
id
capability_version_id
type
input
expected
```

## TestRun

```text
id
capability_version_id
release_id
result
duration_ms
sanitized_evidence
created_at
```

## Release

```text
id
project_id
semantic_version
content_hash
sri_hash
allowed_origins
status
artifact_path
published_at
```

## GitHubInstallation

```text
organization_id
installation_id
account_login
selected_repository_ids
```

No installation token stored persistently.

## AuditEvent

```text
organization_id
project_id
actor_id
action
resource_type
resource_id
sanitized_metadata
created_at
```

---

# 25. Service APIs

## Project and source management

```text
POST   /api/projects
GET    /api/projects/:id
DELETE /api/projects/:id

POST   /api/projects/:id/domain-verifications
POST   /api/domain-verifications/:id/confirm

POST   /api/projects/:id/sources/url
POST   /api/projects/:id/sources/openapi
POST   /api/projects/:id/sources/github
```

## Jobs

```text
POST   /api/projects/:id/jobs
GET    /api/jobs/:id
POST   /api/jobs/:id/cancel
POST   /api/jobs/:id/resume
```

## Capabilities

```text
GET    /api/projects/:id/capabilities
GET    /api/capabilities/:id
PATCH  /api/capabilities/:id
POST   /api/capabilities/:id/approve
POST   /api/capabilities/:id/reject
```

## Verification

```text
POST   /api/capabilities/:id/verification-plan
POST   /api/capabilities/:id/verify
GET    /api/capabilities/:id/test-runs
```

## Releases

```text
POST   /api/projects/:id/releases
GET    /api/releases/:id
POST   /api/releases/:id/publish
POST   /api/releases/:id/rollback
```

## GitHub

```text
POST   /api/github/installations/callback
GET    /api/github/repositories
POST   /api/projects/:id/github/pull-request
```

---

# 26. Product Screens

## 26.1 Dashboard

```text
Acme Support Console
https://support.example.com

Domain:
Verified

Sources:
Live Website   Connected
OpenAPI        Connected
GitHub         Connected

Production Release:
v1.2.0
```

## 26.2 Autonomous scan progress

```text
Explorer
✓ Mapped 22 views
✓ Detected Orders, Tickets, Customers

Protocol Analyst
✓ Observed 11 API shapes
✓ Detected same-origin session authentication
✓ Detected CSRF meta token

Capability Designer
✓ Proposed 8 capabilities

Security Critic
✓ Approved 5 candidates
⚠ 2 require source confirmation
✕ 1 high-risk action blocked
```

## 26.3 Capability list

| Capability | Evidence | Risk | Status |
|---|---|---:|---|
| `find_order` | Runtime + OpenAPI + Source | R0 | Production-ready |
| `get_order_status` | Runtime + OpenAPI | R0 | Production-ready |
| `create_support_ticket` | Runtime + Source | R1 | Verified |
| `cancel_order` | Runtime | R2 | Requires source |
| `delete_account` | Runtime | R3 | Blocked |

## 26.4 Security summary

```text
No persisted target credentials
Cross-origin exposure disabled
3/3 replay passed
0 high-severity findings
1 capability requires GitHub hardening
```

## 26.5 Capability detail

Sections:

- What the tool does
- Where it came from
- Inputs
- Authentication
- Authorization
- Effects
- Output
- Risk
- Confirmation
- Verification
- Installation
- Version history

## 26.6 Verification Lab

Tabs:

- Contract
- Authentication
- Replay
- Agent eval
- Security
- Chrome
- Drift

## 26.7 Release screen

```text
Candidate v1.3.0

Added:
create_support_ticket

Changed:
get_order_status

Verification:
All required gates passed

[Download] [Create GitHub PR] [Publish]
```

---

# 27. Magic Moments

## 27.1 One input

The user pastes:

```text
https://support.example.com
```

Page2WebMCP responds:

> We found an authenticated application. Verify ownership and sign in to begin autonomous discovery.

## 27.2 Authenticate without handing credentials to an agent prompt

The user signs in inside the embedded browser.

Page2WebMCP displays:

```text
Authenticated session detected
Persistent browser profile disabled
Credential values not stored by Page2WebMCP
```

## 27.3 Watch an application become a capability graph

```text
22 views mapped
11 API shapes correlated
8 capabilities discovered
5 safe to generate
```

## 27.4 Agents propose the test plan

The user does not teach a workflow.

Page2WebMCP proposes:

> Create one disposable test ticket, verify it appears, and confirm the WebMCP tool returns only the approved fields.

## 27.5 Runtime proof

```text
create_support_ticket

Schema                 Passed
Logged-out rejection   Passed
Authorized execution   Passed
Visible UI update      Passed
Replay                  3/3
Agent selection         19/20
Secret scan             Passed
```

## 27.6 Source hardening

The user clicks:

```text
Harden with GitHub
```

Page2WebMCP locates the source authorization and opens a minimal PR.

## 27.7 Before and after

Before WebMCP:

- agent searches the DOM;
- clicks through dialogs;
- guesses field semantics;
- may fail mid-flow.

After WebMCP:

```text
Tool selected: create_support_ticket
Arguments validated
Existing authorization executed
Confirmation displayed
Ticket created
UI updated
```

---

# 28. Demonstration Application

Use one public Next.js fixture for all three paths.

## Acme Support Console

Features:

- authenticated support-agent login;
- order search;
- order details;
- shipment status;
- ticket creation;
- priority update;
- account settings;
- intentionally blocked account deletion.

Evidence sources:

- deployed URL;
- public OpenAPI document;
- public GitHub repository.

Generated tools:

### `find_order`

- R0;
- read-only;
- search by ID or email;
- output minimized.

### `get_order_status`

- R0;
- read-only;
- customer notes marked untrusted;
- no payment fields.

### `create_support_ticket`

- R1;
- mutation;
- confirmation;
- disposable test data;
- visible UI update.

Blocked demonstration:

### `delete_account`

- R3;
- discovered;
- no executable tool generated.

This makes safe refusal part of the product demonstration.

---

# 29. Three-Minute Demo Script

## 0:00–0:15 — Problem

> WebMCP lets websites expose structured tools to browser agents. But adding it to an existing application still means understanding every workflow, API, authentication path, schema, and side effect.

## 0:15–0:28 — Positioning

Show homepage:

> **Page2WebMCP: Paste your website or OpenAPI URL → get a production-ready WebMCP layer in minutes.**

Paste the Acme Support URL.

## 0:28–0:47 — Authentication

Open the embedded Browser Use session.

Sign in.

Click:

```text
I’m signed in — start autonomous discovery
```

## 0:47–1:14 — Autonomous exploration

Show live progress:

```text
17 views mapped
8 API shapes observed
6 capabilities found
```

Briefly show the Browser Use agent navigating and the Page2WebMCP capability graph appearing.

## 1:14–1:34 — Review

Open `create_support_ticket`.

Show:

- inputs;
- API evidence;
- existing session;
- effects;
- R1 risk;
- output projection.

Show `delete_account` blocked as R3.

## 1:34–1:52 — Verification

Approve the disposable test-ticket plan.

Show:

```text
Replay 3/3
Logged-out rejection passed
Secret scan passed
Agent selection 19/20
```

## 1:52–2:10 — Publish

Click:

```text
Publish v1.0.0
```

Show:

- bundle;
- content hash;
- allowed origin;
- installation snippet.

## 2:10–2:36 — Agent use

Open Acme Support in Chrome or ChatGPT’s in-app browser.

Prompt:

> Find order ORD-4812 and create a high-priority ticket saying the shipment arrived damaged.

Show:

- `find_order`;
- `create_support_ticket`;
- confirmation;
- ticket appearing in the existing UI.

## 2:36–2:51 — Three evidence paths

Return to Page2WebMCP.

Show:

```text
Runtime observed
OpenAPI confirmed
Source confirmed
```

Open the generated GitHub PR.

## 2:51–3:00 — Close

> Page2WebMCP turns the web we already have into the agent-native web—starting with nothing but a URL.

---

# 30. 72-Hour Build Plan

## Hours 0–6 — Product skeleton and fixture

- Build Acme Support Console.
- Add authentication.
- Add order search.
- Add ticket creation.
- Add OpenAPI document.
- Prepare public repository.
- Manually implement one WebMCP tool.
- Confirm it works in Chrome.

**Exit:** One hand-written tool is visible and callable.

## Hours 6–16 — Shared compiler

- Define CapabilityIR.
- Implement imperative registration templates.
- Implement input validation.
- Implement output projection.
- Implement origin lock.
- Implement confirmation.
- Implement typed errors.
- Implement bundle manifest.
- Implement direct execution test.

**Exit:** Hand-authored CapabilityIR produces a working bundle.

## Hours 16–34 — URL path

- Safe URL preflight.
- Domain verification for fixture.
- Browser Use session.
- Embedded live view.
- Mastra authentication suspension.
- Playwright/CDP connection.
- Read-only request firewall.
- Bounded autonomous explorer.
- DOM and network evidence.
- Sanitizer.
- Capability synthesis.
- Owner review.
- Controlled mutation validation.
- URL bundle generation.

**Exit:** URL alone produces `find_order` and `create_support_ticket`.

## Hours 34–44 — OpenAPI path

- JSON/YAML parsing.
- OpenAPI version support.
- Safe reference resolution.
- Operation extraction.
- Authentication classification.
- Operation grouping.
- Browser/server-adapter generation.
- Contract tests.

**Exit:** OpenAPI path produces the same three tools independently.

## Hours 44–57 — GitHub path

- GitHub App.
- Selected repository installation.
- Next.js detection.
- Route, form, Server Action, Zod, and auth analysis.
- Source capability graph.
- Generated files.
- Branch and draft PR.
- Typecheck and tests.
- Vercel preview detection.

**Exit:** GitHub path opens a working PR.

## Hours 57–65 — Production gates

- Verification Lab.
- Logged-out tests.
- secret canary;
- security critic;
- prompt-injection fixture;
- risk tiers;
- production-ready status;
- immutable release;
- SRI;
- audit events;
- RLS tests.

**Exit:** Production status cannot be awarded without passing gates.

## Hours 65–72 — Demo and submission

- Polish onboarding.
- Seed demonstration project.
- Test Chrome 149.
- Test ChatGPT in-app browser.
- Record three-minute video.
- Finish README.
- Add license.
- Add security model.
- Add judge instructions.
- Submit before deadline.

---

# 31. Ruthless MVP Scope

## Must work

- one website fixture;
- one OpenAPI fixture;
- one GitHub fixture;
- one authenticated session;
- one read tool;
- one second read tool;
- one low-risk mutation;
- one blocked high-risk tool;
- same-origin cookie authentication;
- JSON API;
- standard HTML forms;
- imperative WebMCP;
- Chrome;
- ChatGPT in-app browser;
- Next.js App Router;
- TypeScript;
- generated bundle;
- generated PR;
- direct test;
- agent-selection eval.

## Explicitly cut

- arbitrary websites;
- arbitrary source frameworks;
- persistent Browser Use profiles;
- GraphQL;
- WebSockets;
- uploads;
- payments;
- billing;
- automatic merging;
- declarative WebMCP;
- continuous production monitoring;
- enterprise SSO;
- billing for Page2WebMCP;
- team invitations;
- complex monorepos;
- automatic cleanup for unsupported mutations.

---

# 32. Success Metrics

## 32.1 Hackathon metrics

- All three paths complete independently.
- URL path requires no source or API contract.
- Browser authentication succeeds without stored credential values.
- At least three capabilities are discovered.
- At least one mutation visibly updates the application.
- Chrome discovers generated tools.
- Direct tool execution passes.
- Natural-language selection passes.
- GitHub PR passes checks.
- OpenAPI path produces working browser or server-adapter output.
- Complete demo remains under three minutes.

## 32.2 Product metrics

- time to first candidate;
- time to verified capability;
- percentage of candidates approved;
- percentage blocked for safety;
- deterministic replay pass rate;
- agent-selection accuracy;
- execution success rate;
- percentage requiring GitHub hardening;
- drift frequency;
- average scan cost;
- average browser steps;
- release rollback rate.

## 32.3 Security metrics

```text
Persisted raw credentials:                0
Browser bundles containing server secret: 0
Wildcard cross-origin exposure:           0
High-severity findings in production:     0
Unauthorized cross-tenant reads:          0
Mutations without declared effects:       0
Production releases without rollback:     0
```

---

# 33. Acceptance Criteria

## 33.1 Shared platform

- [ ] User can sign in.
- [ ] User can create a project.
- [ ] Primary field accepts website and OpenAPI URLs.
- [ ] GitHub connection is available separately.
- [ ] Every path produces CapabilityIR.
- [ ] Every capability displays evidence.
- [ ] Every capability displays authentication and effects.
- [ ] User can edit, approve, reject, or block a capability.
- [ ] Generated implementation uses imperative WebMCP.
- [ ] Generated tools are origin-locked.
- [ ] `exposedTo` is omitted by default.
- [ ] Input schemas reject additional properties.
- [ ] Outputs use an explicit allowlist.
- [ ] Verification Lab can execute tools directly.
- [ ] Natural-language selection evals run.
- [ ] Releases are versioned and immutable.
- [ ] Release can be downloaded.
- [ ] Release can be installed.
- [ ] Chrome discovers tools.
- [ ] Application UI reflects successful mutations.

## 33.2 Website URL path

- [ ] HTTPS URL accepted.
- [ ] Private-network targets rejected.
- [ ] Redirects revalidated.
- [ ] Domain ownership verified.
- [ ] User selects allowed paths and origins.
- [ ] Ephemeral Browser Use session created.
- [ ] Live browser embedded.
- [ ] Mastra suspends for authentication.
- [ ] User authenticates manually.
- [ ] No persistent Browser Use profile used.
- [ ] Playwright connects over CDP.
- [ ] Read-only request firewall active.
- [ ] Explorer maps at least ten fixture views.
- [ ] DOM, network, and state evidence captured.
- [ ] Raw credentials removed before persistence.
- [ ] At least one R0 capability generated.
- [ ] At least one R1 capability generated.
- [ ] Mutation requires owner approval.
- [ ] Three replays pass.
- [ ] Browser session terminates.
- [ ] URL path produces an installable release independently.

## 33.3 OpenAPI path

- [ ] OpenAPI URL accepted.
- [ ] JSON upload accepted.
- [ ] YAML upload accepted.
- [ ] 3.0.x supported.
- [ ] 3.1.x supported.
- [ ] 3.2.x supported.
- [ ] Unsafe external references blocked.
- [ ] Operations extracted.
- [ ] Security schemes extracted.
- [ ] Operations grouped into capabilities.
- [ ] API key generates server adapter.
- [ ] Server secret absent from browser code.
- [ ] Request serialization tests pass.
- [ ] Authentication-negative test passes.
- [ ] OpenAPI path produces a working release independently.

## 33.4 GitHub path

- [ ] GitHub App installation works.
- [ ] User selects one repository.
- [ ] Only required permissions requested.
- [ ] Installation token minted on demand.
- [ ] Token not persisted.
- [ ] Next.js App Router detected.
- [ ] Route Handlers detected.
- [ ] Server Actions detected.
- [ ] Zod schemas detected.
- [ ] Auth helper detected.
- [ ] Authorization evidence displayed.
- [ ] Generated implementation reuses existing logic.
- [ ] Branch created.
- [ ] Draft PR opened.
- [ ] Typecheck passes.
- [ ] Tests pass.
- [ ] Vercel preview link displayed when available.
- [ ] GitHub path produces a working implementation independently.

## 33.5 Security

- [ ] Password never stored.
- [ ] Raw cookie never stored.
- [ ] Authorization header never stored.
- [ ] Refresh token never stored.
- [ ] Browser live URL never logged.
- [ ] Browser CDP URL never logged.
- [ ] Prompt-injection fixture cannot change tool semantics.
- [ ] `untrustedContentHint` applied where needed.
- [ ] Logged-out execution fails.
- [ ] R1 mutation displays confirmation.
- [ ] R2 capability requires stronger evidence.
- [ ] R3 capability is blocked.
- [ ] Managed release includes integrity hash.
- [ ] Self-hosted installation available.
- [ ] RLS tests pass.
- [ ] Cross-tenant tests pass.
- [ ] Production-ready gate cannot be skipped silently.

---

# 34. Major Risks and Mitigations

## URL path appears unsafe

**Mitigation:** Make security visible in the product: verified domain, ephemeral browser, no profile, no stored tokens, request firewall, explicit mutation plan, production gates.

## URL path only works on fixture

**Mitigation:** Clearly define the supported application envelope. Unsupported diagnosis is a valid result.

## Browser agent misses important pages

**Mitigation:** Bounded breadth-first exploration, route graph, semantic state fingerprints, “Guide explorer” fallback.

## Browser agent performs a mutation during discovery

**Mitigation:** CDP request firewall blocks the action regardless of model behavior.

## Application mutates through GET

**Mitigation:** Block suspicious routes, controls, and observed state-changing GET patterns.

## GitHub path looks like a coding agent

**Mitigation:** Show that source generation begins from a normalized capability with runtime and contract evidence.

## Three paths dilute implementation effort

**Mitigation:** Use one CapabilityIR, one compiler, one fixture, one verification pipeline, and the same three capabilities.

## “Production-ready” is challenged by judges

**Mitigation:** Show the release gate and a deliberately blocked high-risk tool. Explain that the status is earned by tests.

## WebMCP draft changes

**Mitigation:** Isolate WebMCP calls in one runtime module, record compatibility date, use feature detection, and test in both judging environments.

## Browser Use processing boundary concerns

**Mitigation:** Recommend staging, disable persistence and recording, terminate sessions, and be explicit about the subprocesser boundary.

## Mutation duplicates data

**Mitigation:** No mutation retries without idempotency and use disposable test resources.

## Repository executes malicious code

**Mitigation:** Static analysis first, no secrets, no install scripts, restricted sandbox, and existing CI as final validation.

## OpenAPI reference SSRF

**Mitigation:** Disable remote references by default and validate every explicitly allowed retrieval.

## Managed bundle supply-chain concern

**Mitigation:** Recommend self-hosting and offer immutable SRI-pinned managed output.

---

# 35. Post-Hackathon Roadmap

## Phase 1 — Broader website support

- local Chrome companion extension;
- private-network applications;
- persistent connections with explicit consent;
- scheduled drift scans;
- additional authentication systems;
- better semantic UI bridges.

## Phase 2 — Source ecosystems

- Next.js Pages Router;
- Remix;
- SvelteKit;
- Nuxt;
- Rails;
- Django;
- Laravel;
- Shopify;
- WordPress.

## Phase 3 — API ecosystems

- GraphQL;
- tRPC;
- gRPC transcoding;
- event-driven workflows;
- webhook-to-tool patterns;
- file and multipart support.

## Phase 4 — Enterprise

- self-hosted Browser Use;
- customer VPC workers;
- private model providers;
- custom retention;
- SSO;
- RBAC;
- audit export;
- policy-as-code;
- approval workflows;
- penetration testing;
- compliance reports.

## Phase 5 — Continuous WebMCP release engineering

- capability drift alerts;
- automatic regeneration PRs;
- tool performance analytics;
- agent compatibility matrices;
- model-specific eval suites;
- staged releases;
- canary tools;
- production rollback automation.

---

# 36. Prioritized Implementation Checklist

## P0 — Required for submission

- [ ] Create public Acme Support fixture.
- [ ] Implement authentication.
- [ ] Implement order search.
- [ ] Implement order status.
- [ ] Implement ticket creation.
- [ ] Add OpenAPI specification.
- [ ] Add public GitHub repository.
- [ ] Implement one hand-written WebMCP tool.
- [ ] Test in Chrome.
- [ ] Define CapabilityIR.
- [ ] Build imperative WebMCP generator.
- [ ] Build origin lock.
- [ ] Build input validation.
- [ ] Build output projection.
- [ ] Build confirmation modal.
- [ ] Build typed errors.
- [ ] Build release manifest.
- [ ] Build Supabase schema.
- [ ] Enable and test RLS.
- [ ] Configure Supabase Queue.
- [ ] Configure Render worker.
- [ ] Configure Mastra workflow storage.
- [ ] Implement URL classifier.
- [ ] Implement SSRF-safe preflight.
- [ ] Implement domain verification.
- [ ] Integrate Browser Use.
- [ ] Embed live browser.
- [ ] Implement authentication suspension.
- [ ] Connect Playwright over CDP.
- [ ] Implement request firewall.
- [ ] Implement autonomous exploration.
- [ ] Implement evidence sanitizer.
- [ ] Implement capability designer.
- [ ] Implement security critic.
- [ ] Implement owner review.
- [ ] Implement mutation approval.
- [ ] Implement replay.
- [ ] Implement OpenAPI parser.
- [ ] Implement operation grouping.
- [ ] Implement authentication classifier.
- [ ] Implement server-adapter generation.
- [ ] Create GitHub App.
- [ ] Implement Next.js source scan.
- [ ] Implement PR generation.
- [ ] Implement direct WebMCP test.
- [ ] Implement agent-selection eval.
- [ ] Implement secret canary.
- [ ] Implement risk tiers.
- [ ] Implement production-ready release gate.
- [ ] Publish immutable bundle.
- [ ] Add integrity hash.
- [ ] Test ChatGPT in-app browser.
- [ ] Record three-minute video.
- [ ] Add open-source license.
- [ ] Complete Devpost submission.

## P1 — Add after P0 is stable

- [ ] Source-fusion screen.
- [ ] Runtime/OpenAPI conflict detection.
- [ ] GitHub source hardening from URL capability.
- [ ] Vercel preview automation.
- [ ] Lighthouse result display.
- [ ] Rollback UI.
- [ ] Drift fingerprints.
- [ ] Security report download.
- [ ] Audit-log screen.
- [ ] Optional privacy-preserving runtime telemetry.

## P2 — Post-hackathon

- [ ] Local Chrome extension.
- [ ] Self-hosted browser worker.
- [ ] Additional frameworks.
- [ ] GraphQL.
- [ ] File workflows.
- [ ] Persistent authenticated connections.
- [ ] Continuous drift monitoring.
- [ ] Dynamic regeneration PRs.
- [ ] Organization policy engine.
- [ ] Enterprise deployment.
- [ ] Formal security assessment.

---

# 37. Submission Requirements Checklist

The challenge requires a working live URL accessible through ChatGPT’s in-app browser or Chrome with WebMCP enabled, a public code repository with a visible open-source license, and a public YouTube video under three minutes. Judges may inspect the running project, description, repository, and WebMCP implementation.

- [ ] Register on Devpost.
- [ ] Verify exact submission deadline.
- [ ] Make live application accessible.
- [ ] Add judge credentials.
- [ ] Test all three paths.
- [ ] Test Chrome 149+.
- [ ] Test ChatGPT in-app browser.
- [ ] Make repository public.
- [ ] Add license file.
- [ ] Ensure license is visible in repository metadata.
- [ ] Include full setup instructions.
- [ ] Document WebMCP implementation.
- [ ] Include security architecture.
- [ ] Include test instructions.
- [ ] Record public YouTube demo.
- [ ] Keep demo below three minutes.
- [ ] Show real WebMCP invocation.
- [ ] Show existing UI changing.
- [ ] Show no-token-storage model.
- [ ] Show blocked high-risk capability.
- [ ] Show all three evidence paths.
- [ ] Freeze submitted project during judging.

---

# 38. Final Product Copy

## Hero

> **Page2WebMCP**  
> **Paste your website or OpenAPI URL → get a production-ready WebMCP layer in minutes.**

## Subheading

> Authenticate once and let our agents explore your application, discover useful workflows, generate structured WebMCP tools, and verify that they work safely.

## Primary CTA

```text
Analyze my website or API
```

## Secondary CTA

```text
Connect GitHub
```

## Website result

> We explored your application.

```text
22 views mapped
11 API shapes observed
8 capabilities discovered
5 ready for WebMCP
2 require source confirmation
1 blocked for security
```

## Security line

> Your users’ credentials stay in their browser session. Page2WebMCP generates tools that use your existing authentication and authorization.

## GitHub line

> Connect your Next.js repository to confirm authorization and receive a tested source-native pull request.

## Final one-liner

> **Paste a site. Let our agents understand it. Ship WebMCP.**