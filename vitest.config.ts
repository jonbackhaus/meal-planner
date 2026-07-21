import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Never pick up tests inside git worktrees created under .claude/; a
    // repo-root `vitest` run would otherwise double the test/file counts.
    exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
  },
});
