#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  checkoutBranch,
  commitHistory,
  createBranch,
  createCommit,
  findRepository,
  initRepository,
  listBranches,
  stagePaths,
  status,
  writeIndex,
} from "./repository.js";

function printChanges(title, changes) {
  if (!changes.length) return;
  console.log(`\n${title}`);
  for (const change of changes) console.log(`  ${change.kind.padEnd(10)} ${change.file}`);
}

const cli = yargs(hideBin(process.argv))
  .scriptName("gvx")
  .usage("Usage: $0 <command> [options]")
  .command("init", "Initialize a repository in the current folder", {}, async () => {
    try {
      const repo = await initRepository();
      console.log(`Initialized empty GVX repository in ${repo.dir}`);
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .command("status", "Show staged and working-tree changes", {}, async () => {
    try {
      const state = await status(await findRepository());
      console.log(`On branch ${state.branch}`);
      if (state.clean) console.log("Working tree clean");
      printChanges("Changes to be committed:", state.staged.filter((item) => item.kind !== "unchanged"));
      printChanges("Changes not staged:", state.unstaged);
      printChanges("Untracked files:", state.untracked);
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .command("add <paths..>", "Stage files or folders (use . for the whole repository)", (command) => command.positional("paths", { type: "string", array: true }), async (argv) => {
    try {
      const repo = await findRepository();
      const result = await stagePaths(repo, argv.paths);
      await writeIndex(repo, result.index);
      console.log(`Staged ${result.count} path${result.count === 1 ? "" : "s"}.`);
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .command("commit", "Save staged changes as a commit", (command) => command.option("message", { alias: "m", type: "string", demandOption: true, describe: "Commit message" }), async (argv) => {
    try {
      const commit = await createCommit(await findRepository(), argv.message.trim());
      console.log(`[${commit.branch} ${commit.id.slice(0, 7)}] ${commit.message}`);
      console.log(`${Object.keys(commit.tree).length} file${Object.keys(commit.tree).length === 1 ? "" : "s"} in snapshot`);
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .command("log", "Show commit history", {}, async () => {
    try {
      const commits = await commitHistory(await findRepository());
      if (!commits.length) { console.log("No commits yet."); return; }
      for (const commit of commits) {
        console.log(`commit ${commit.id}`);
        console.log(`Branch: ${commit.branch}`);
        console.log(`Date:   ${new Date(commit.timestamp).toLocaleString()}`);
        console.log(`\n    ${commit.message}\n`);
      }
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .command("branch [name]", "List branches or create one", (command) => command.positional("name", { type: "string", describe: "New branch name" }), async (argv) => {
    try {
      const repo = await findRepository();
      if (argv.name) {
        await createBranch(repo, argv.name);
        console.log(`Created branch '${argv.name}'.`);
      } else {
        for (const branch of await listBranches(repo)) console.log(`${branch.current ? "*" : " "} ${branch.name}`);
      }
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .command("checkout <branch>", "Switch to an existing branch", (command) => command.positional("branch", { type: "string", demandOption: true }), async (argv) => {
    try {
      await checkoutBranch(await findRepository(), argv.branch);
      console.log(`Switched to branch '${argv.branch}'.`);
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .command("diff", "List unstaged file changes", {}, async () => {
    try {
      const state = await status(await findRepository());
      printChanges("Unstaged changes:", state.unstaged);
      printChanges("Untracked files:", state.untracked);
      if (!state.unstaged.length && !state.untracked.length) console.log("No unstaged changes.");
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .command("push", "Push commits to a configured GVX server", {}, async () => {
    try {
      const repo = await findRepository();
      const config = JSON.parse(await (await import("node:fs/promises")).readFile(`${repo.dir}/config.json`, "utf8"));
      if (!config.remotes?.origin) throw new Error("No remote configured. Add a GVX-compatible server with `gvx remote add origin <url>`.");
      throw new Error("Remote push is not implemented yet. A GVX server endpoint is required; this CLI cannot push to GitHub or another Git remote.");
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .command("remote add <name> <url>", "Save a remote server URL", (command) => command
    .positional("name", { type: "string" })
    .positional("url", { type: "string" }), async (argv) => {
    try {
      const repo = await findRepository();
      const { promises: fs } = await import("node:fs");
      const configPath = `${repo.dir}/config.json`;
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      const url = new URL(argv.url);
      if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Remote URL must use http or https.");
      config.remotes ??= {};
      config.remotes[argv.name] = url.toString();
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      console.log(`Added remote '${argv.name}' (${url}).`);
    } catch (error) { console.error(`gvx: ${error.message}`); process.exitCode = 1; }
  })
  .demandCommand(1, "Choose a command. Run `gvx --help` for usage.")
  .strict()
  .help();

await cli.parseAsync();
