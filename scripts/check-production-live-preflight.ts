import { pathToFileURL } from "node:url";
import {
  evaluateProductionLivePreflight,
  parseProductionLiveCommandArguments,
  type ProductionLiveCommandResultV1,
} from "../packages/operations/src/production-live.ts";

export type ProductionLivePreflightCliResult = Readonly<{
  output: ProductionLiveCommandResultV1;
  exitCode: 0 | 1 | 2;
}>;

export function runProductionLivePreflightCli(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ProductionLivePreflightCliResult {
  const parsed = parseProductionLiveCommandArguments(args);
  if (!parsed) {
    return {
      output: {
        schema: "ProductionLiveCommandResultV1",
        journey: "openapi",
        mode: "dry-run",
        status: "failed",
        code: "PRODUCTION_LIVE_ARGUMENTS_INVALID",
        missingControls: [],
        plannedOperations: [],
        completedOperations: [],
        liveSuccess: false,
      },
      exitCode: 2,
    };
  }
  const output = evaluateProductionLivePreflight({ ...parsed, environment });
  return { output, exitCode: output.status === "failed" ? 1 : 0 };
}

async function main(): Promise<void> {
  const result = runProductionLivePreflightCli(process.argv.slice(2), process.env);
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
