import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const META = ".gvx";
const DEFAULT_BRANCH = "main";
const IGNORED_DIRS = new Set([".git", ".gvx", "node_modules", ".next"]);

export function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function normalizePath(value) {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "").replace(/\/$/, "");
  if (normalized === ".." || normalized.startsWith("../") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Path must be inside the repository: ${value}`);
  }
  if (!normalized || normalized === ".") return ".";
  return normalized;
}

export async function findRepository(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    try {
      const stat = await fs.stat(path.join(current, META));
      if (stat.isDirectory()) return { root: current, dir: path.join(current, META) };
    } catch { /* Keep looking in the parent directory. */ }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Not inside a GVX repository. Run `gvx init` first.");
    current = parent;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

export async function initRepository(root = process.cwd()) {
  const repoDir = path.join(path.resolve(root), META);
  try { await fs.access(repoDir); throw new Error("A GVX repository already exists here."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(path.join(repoDir, "objects"), { recursive: true });
  await fs.mkdir(path.join(repoDir, "commits"), { recursive: true });
  await fs.mkdir(path.join(repoDir, "refs", "heads"), { recursive: true });
  await fs.writeFile(path.join(repoDir, "HEAD"), `ref: refs/heads/${DEFAULT_BRANCH}\n`, "utf8");
  await fs.writeFile(path.join(repoDir, "refs", "heads", DEFAULT_BRANCH), "", "utf8");
  await writeJson(path.join(repoDir, "index.json"), {});
  await writeJson(path.join(repoDir, "config.json"), { version: 1 });
  return { root: path.resolve(root), dir: repoDir };
}

export async function readHead(repo) {
  const head = (await fs.readFile(path.join(repo.dir, "HEAD"), "utf8")).trim();
  if (!head.startsWith("ref: refs/heads/")) throw new Error("Detached HEAD is not supported yet.");
  const branch = head.slice("ref: refs/heads/".length);
  const commitId = (await fs.readFile(path.join(repo.dir, "refs", "heads", branch), "utf8")).trim();
  return { branch, commitId: commitId || null };
}

export async function readCommit(repo, id) {
  if (!id) return null;
  return readJson(path.join(repo.dir, "commits", `${id}.json`), null);
}

export async function readIndex(repo) {
  return readJson(path.join(repo.dir, "index.json"), {});
}

async function ignoreRules(root) {
  const rules = [];
  for (const filename of [".gitignore", ".gvxignore"]) {
    try {
      rules.push(...(await fs.readFile(path.join(root, filename), "utf8"))
        .split(/\r?\n/).map((rule) => rule.trim()).filter((rule) => rule && !rule.startsWith("#")));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return rules;
}

function isIgnored(relative, rules) {
  const segments = relative.split("/");
  if (segments.some((segment) => IGNORED_DIRS.has(segment))) return true;
  return rules.some((rawRule) => {
    const rule = rawRule.replace(/^\//, "");
    const directoryRule = rule.endsWith("/");
    const pattern = rule.replace(/\/$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const regex = new RegExp(`(^|/)${pattern}${directoryRule ? "(/|$)" : "($|/)"}`);
    return regex.test(relative);
  });
}

export async function scanWorkingTree(repo) {
  const rules = await ignoreRules(repo.root);
  const result = {};
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(repo.root, absolute).split(path.sep).join("/");
      if (isIgnored(relative, rules)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result[relative] = hash(await fs.readFile(absolute));
    }
  }
  await walk(repo.root);
  return result;
}

export async function stagePaths(repo, paths) {
  const index = await readIndex(repo);
  const { commitId } = await readHead(repo);
  const commit = await readCommit(repo, commitId);
  const baseTree = commit?.tree ?? {};
  const workingTree = await scanWorkingTree(repo);
  const targets = paths.map(normalizePath);
  if (targets.includes(".")) {
    for (const [file, objectId] of Object.entries(workingTree)) {
      if (baseTree[file] === objectId) delete index[file];
      else {
        await saveObject(repo, objectId, path.join(repo.root, ...file.split("/")));
        index[file] = { hash: objectId };
      }
    }
    for (const file of Object.keys(baseTree)) {
      if (!workingTree[file]) index[file] = { deleted: true };
    }
    for (const file of Object.keys(index)) {
      if (!workingTree[file] && !baseTree[file]) delete index[file];
    }
    return { index, count: Object.keys(index).length };
  }
  for (const target of targets) {
    const matched = new Set([...Object.keys(workingTree), ...Object.keys(baseTree), ...Object.keys(index)].filter((file) => file === target || file.startsWith(`${target}/`)));
    if (!matched.size) throw new Error(`Path '${target}' did not match any files.`);
    for (const file of matched) {
      if (workingTree[file]) {
        if (baseTree[file] === workingTree[file]) delete index[file];
        else {
          await saveObject(repo, workingTree[file], path.join(repo.root, ...file.split("/")));
          index[file] = { hash: workingTree[file] };
        }
      } else if (baseTree[file]) index[file] = { deleted: true };
      else delete index[file];
    }
  }
  return { index, count: Object.keys(index).length };
}

async function saveObject(repo, objectId, source) {
  const target = path.join(repo.dir, "objects", objectId);
  try { await fs.access(target); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.copyFile(source, target);
  }
}

export async function writeIndex(repo, index) {
  await writeJson(path.join(repo.dir, "index.json"), index);
}

export async function status(repo) {
  const { branch, commitId } = await readHead(repo);
  const commit = await readCommit(repo, commitId);
  const baseTree = commit?.tree ?? {};
  const index = await readIndex(repo);
  const workingTree = await scanWorkingTree(repo);
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const [file, change] of Object.entries(index)) {
    if (change.deleted) staged.push({ file, kind: "deleted" });
    else {
      if (baseTree[file] !== change.hash) staged.push({ file, kind: baseTree[file] ? "modified" : "added" });
    }
  }
  for (const [file, objectId] of Object.entries(workingTree)) {
    if (Object.hasOwn(index, file)) {
      if (index[file].deleted || index[file].hash !== objectId) unstaged.push({ file, kind: "modified" });
    } else if (Object.hasOwn(baseTree, file)) {
      if (baseTree[file] !== objectId) unstaged.push({ file, kind: "modified" });
    } else untracked.push({ file, kind: "untracked" });
  }
  for (const file of Object.keys(baseTree)) {
    if (!Object.hasOwn(workingTree, file) && !Object.hasOwn(index, file)) unstaged.push({ file, kind: "deleted" });
  }
  for (const [file, change] of Object.entries(index)) {
    if (!change.deleted && !Object.hasOwn(workingTree, file)) unstaged.push({ file, kind: "deleted" });
  }
  return { branch, commitId, staged, unstaged, untracked, clean: !staged.length && !unstaged.length && !untracked.length };
}

export async function createCommit(repo, message) {
  const { branch, commitId: parent } = await readHead(repo);
  const index = await readIndex(repo);
  if (!Object.keys(index).length) throw new Error("Nothing to commit. Stage changes with `gvx add` first.");
  const previous = await readCommit(repo, parent);
  const tree = { ...(previous?.tree ?? {}) };
  for (const [file, change] of Object.entries(index)) {
    if (change.deleted) delete tree[file];
    else tree[file] = change.hash;
  }
  const commit = { parent, message, branch, timestamp: new Date().toISOString(), tree };
  const id = hash(JSON.stringify(commit));
  await writeJson(path.join(repo.dir, "commits", `${id}.json`), { id, ...commit });
  await fs.writeFile(path.join(repo.dir, "refs", "heads", branch), `${id}\n`, "utf8");
  await writeIndex(repo, {});
  return { id, ...commit };
}

export async function listBranches(repo) {
  const { branch: current } = await readHead(repo);
  const names = await fs.readdir(path.join(repo.dir, "refs", "heads"));
  return names.map((name) => ({ name, current: name === current }));
}

export async function createBranch(repo, name) {
  const safeName = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(safeName)) throw new Error("Branch name must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.");
  const target = path.join(repo.dir, "refs", "heads", safeName);
  try { await fs.access(target); throw new Error(`Branch '${safeName}' already exists.`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const { commitId } = await readHead(repo);
  await fs.writeFile(target, `${commitId ?? ""}\n`, "utf8");
}

export async function checkoutBranch(repo, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("Invalid branch name.");
  const target = path.join(repo.dir, "refs", "heads", name);
  try { await fs.access(target); } catch (error) { if (error.code === "ENOENT") throw new Error(`Branch '${name}' does not exist.`); throw error; }
  const state = await status(repo);
  if (!state.clean) throw new Error("Cannot switch branches with uncommitted changes. Commit or stage and commit them first.");
  const { commitId: currentId } = await readHead(repo);
  const current = await readCommit(repo, currentId);
  const next = await readCommit(repo, (await fs.readFile(target, "utf8")).trim());
  const currentTree = current?.tree ?? {};
  const nextTree = next?.tree ?? {};
  for (const file of Object.keys(currentTree)) {
    if (!Object.hasOwn(nextTree, file)) await fs.rm(path.join(repo.root, ...file.split("/")), { force: true });
  }
  for (const [file, objectId] of Object.entries(nextTree)) {
    const destination = path.join(repo.root, ...file.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(repo.dir, "objects", objectId), destination);
  }
  await fs.writeFile(path.join(repo.dir, "HEAD"), `ref: refs/heads/${name}\n`, "utf8");
}

export async function commitHistory(repo) {
  const { commitId } = await readHead(repo);
  const commits = [];
  let current = commitId;
  while (current) {
    const commit = await readCommit(repo, current);
    if (!commit) throw new Error(`Commit object '${current}' is missing.`);
    commits.push(commit);
    current = commit.parent;
  }
  return commits;
}

