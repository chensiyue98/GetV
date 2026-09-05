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

test("release versions stay aligned across Xcode targets and the extension manifest", () => {
  const project = readFileSync("get-v.xcodeproj/project.pbxproj", "utf8");
  const manifest = JSON.parse(readFileSync("Shared (Extension)/Resources/manifest.json", "utf8"));
  const marketingVersions = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(match => match[1]);
  const buildVersions = [...project.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map(match => match[1]);

  assert.ok(marketingVersions.length > 0, "Xcode targets must define a marketing version");
  assert.deepEqual([...new Set(marketingVersions)], ["1.1"]);
  assert.deepEqual([...new Set(buildVersions)], ["2"]);
  assert.equal(manifest.version, "1.1.0");
  assert.equal(manifest.version.split(".").slice(0, 2).join("."), marketingVersions[0]);
});
