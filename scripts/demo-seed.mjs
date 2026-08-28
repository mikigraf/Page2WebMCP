const seed = {
  controlPlaneUrl: process.env.PAGE2WEBMCP_CONTROL_PLANE_URL ?? "http://localhost:3100",
  fixtureAppUrl: process.env.PAGE2WEBMCP_FIXTURE_APP_URL ?? "http://localhost:3200",
  owner: { email: "owner@example.test", password: "fixture-password" },
  agent: { email: "agent@example.test", password: "fixture-password" }
};

console.log(JSON.stringify(seed, null, 2));
