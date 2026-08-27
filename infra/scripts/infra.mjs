const action = process.argv[2];
if (!new Set(["up", "down"]).has(action)) throw new Error("usage: infra.mjs up|down");
console.log(`Local in-process test infrastructure ${action}.`);
