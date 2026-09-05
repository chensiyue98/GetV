import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("release workflow uses a runner that can open the Xcode project", () => {
  const project = readFileSync("get-v.xcodeproj/project.pbxproj", "utf8");
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  const objectVersion = Number(project.match(/objectVersion = (\d+);/)?.[1]);

  assert.equal(objectVersion, 110, "update this check when the project format changes");
  assert.match(
    workflow,
    /^\s*runs-on:\s*xcode-27\s*$/m,
    "objectVersion 110 requires the GitHub Xcode 27 runner",
  );
});
