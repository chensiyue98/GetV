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
  assert.equal(new Set(marketingVersions).size, 1);
  assert.ok(buildVersions.length > 0);
  assert.equal(new Set(buildVersions).size, 1);
  const normalized = marketingVersions[0].split(".");
  if (normalized.length === 2) normalized.push("0");
  assert.equal(manifest.version, normalized.join("."));
});

// Run the actual workflow step against an isolated checkout of the version files.
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

for (const [event, input, ref, expected] of [
  ["workflow_dispatch", "1.2", "main", "1.2"],
  ["push", "", "v1.3.4", "1.3.4"],
  ["workflow_dispatch", "1.2-beta", "main", null],
  ["workflow_dispatch", "1.2\nevil", "main", null],
]) {
  test(`release version step: ${event} ${JSON.stringify(input || ref)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "getv-release-"));
    try {
      for (const path of ["scripts", "get-v.xcodeproj", "Shared (Extension)/Resources"]) {
        mkdirSync(join(dir, path), { recursive: true });
      }
      for (const path of ["scripts/set-release-version.mjs", "get-v.xcodeproj/project.pbxproj", "Shared (Extension)/Resources/manifest.json"]) {
        copyFileSync(path, join(dir, path));
      }
      const workflow = readFileSync(".github/workflows/release.yml", "utf8");
      const step = workflow.split("        run: |\n")[1].split("\n      - name:")[0]
        .split("\n").map(line => line.slice(10)).join("\n");
      const output = join(dir, "output");
      const before = readFileSync(join(dir, "get-v.xcodeproj/project.pbxproj"), "utf8");
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step], {
        cwd: dir, encoding: "utf8",
        env: { ...process.env, GITHUB_EVENT_NAME: event, INPUT_VERSION: input, GITHUB_REF_NAME: ref, GITHUB_OUTPUT: output },
      });
      if (!expected) {
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(join(dir, "get-v.xcodeproj/project.pbxproj"), "utf8"), before);
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      const project = readFileSync(join(dir, "get-v.xcodeproj/project.pbxproj"), "utf8");
      const versions = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(match => match[1]);
      assert.deepEqual([...new Set(versions)], [expected]);
      const manifest = JSON.parse(readFileSync(join(dir, "Shared (Extension)/Resources/manifest.json"), "utf8"));
      assert.equal(manifest.version, expected.split(".").length === 2 ? `${expected}.0` : expected);
      assert.equal(readFileSync(output, "utf8"), `version=${expected}\ntag=v${expected}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
