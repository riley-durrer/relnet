// Build a release: a deterministic tarball of the tracked source plus the compiled contract artifacts,
// a manifest (release.json) with per-file hashes and contract class ids, and a SHA256SUMS list.
//   tsx src/release/package.ts [--out release] [--allow-dirty]
// Needs GNU tar and gzip. The same inputs give the same tarball bytes (sorted names, fixed times and owners).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeClassIds } from "./classids.js";

export interface ReleaseManifest {
  name: "relnet";
  version: string;
  commit: string;
  aztec: string;
  classIds: Record<string, string>;
  files: Record<string, string>;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();

const args = process.argv.slice(2);
const outDir = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : "release");
const allowDirty = args.includes("--allow-dirty");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const commit = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
if (!allowDirty && git("status", "--porcelain", "--untracked-files=no") !== "")
  throw new Error("Working tree has uncommitted changes to tracked files. Commit them or pass --allow-dirty.");

const targets = readdirSync("target").filter((f) => f.endsWith(".json"));
if (targets.length === 0) throw new Error("No compiled artifacts in target/. Run `npm run build` first.");
if (!existsSync("src/artifacts")) throw new Error("No src/artifacts/. Run `npm run build` first.");

// What ships: every tracked file, plus the build outputs that are gitignored.
const files = new Set(git("ls-files", "-z").split("\0").filter(Boolean));
for (const f of targets) files.add(`target/${f}`);
for (const f of readdirSync("src/artifacts")) files.add(`src/artifacts/${f}`);
files.delete("release.json");

const root = `relnet-${pkg.version}`;
const stage = path.join(outDir, "stage");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(stage, root), { recursive: true });

const hashes: Record<string, string> = {};
for (const f of [...files].sort()) {
  const dest = path.join(stage, root, f);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(f, dest);
  hashes[f] = sha256(readFileSync(f));
}

const manifest: ReleaseManifest = {
  name: "relnet",
  version: pkg.version,
  commit,
  aztec: pkg.dependencies["@aztec/aztec.js"],
  classIds: await computeClassIds("target"),
  files: hashes,
};
writeFileSync(path.join(stage, root, "release.json"), JSON.stringify(manifest, null, 2) + "\n");

const tgz = path.join(outDir, `${root}.tgz`);
const tar = execFileSync(
  "tar",
  ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", "-", "-C", stage, root],
  { maxBuffer: 1 << 30 },
);
writeFileSync(tgz, execFileSync("gzip", ["-n", "-9"], { input: tar, maxBuffer: 1 << 30 }));
copyFileSync(path.join(stage, root, "release.json"), path.join(outDir, `${root}.release.json`));
rmSync(stage, { recursive: true, force: true });

const sums = [tgz, path.join(outDir, `${root}.release.json`)]
  .map((f) => `${sha256(readFileSync(f))}  ${path.basename(f)}`)
  .join("\n");
writeFileSync(path.join(outDir, "SHA256SUMS"), sums + "\n");

console.log(`${root}.tgz  ${Object.keys(hashes).length + 1} files  commit ${commit.slice(0, 12)}`);
console.log(sums);
console.log("Class ids:");
for (const [k, v] of Object.entries(manifest.classIds)) console.log(`  ${k} ${v}`);
