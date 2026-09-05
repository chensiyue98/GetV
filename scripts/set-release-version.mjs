import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
// Use a numeric version accepted by both the app and Safari extension.
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(version ?? "") ||
    version.split(".").some(part => Number(part) > 65535)) {
  console.error("Invalid release version: expected major.minor or major.minor.patch (0–65535 per component).");
  process.exit(1);
}
const projectPath = "get-v.xcodeproj/project.pbxproj";
const manifestPath = "Shared (Extension)/Resources/manifest.json";
const project = readFileSync(projectPath, "utf8");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!/MARKETING_VERSION = [^;]+;/.test(project)) {
  throw new Error("No MARKETING_VERSION found in Xcode project");
}
manifest.version = version.split(".").length === 2 ? `${version}.0` : version;
writeFileSync(projectPath, project.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + "\n");
console.log(`Release version: ${version}; extension manifest: ${manifest.version}`);
