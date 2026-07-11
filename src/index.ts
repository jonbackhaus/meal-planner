import { getScaffoldVersion } from "./lib/version.js";

export function main(): void {
  console.log(
    `meal-planner daemon scaffold starting (version ${getScaffoldVersion()})`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
