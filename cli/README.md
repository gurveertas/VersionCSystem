# GVX CLI

GVX is an early local version control CLI. It stores repository data in `.gvx/` and content-addresses file snapshots with SHA-256.

## Install globally

After the package is published to npm, anyone can install the `gvx` command with:

```sh
npm install --global gvx
```

Then run `gvx --help` from any project folder.

## Install for local development

From the `cli` directory, run `npm link`. Then use `gvx` from a project folder.

```sh
gvx init
gvx status
gvx add .
gvx commit -m "Start project history"
gvx log
gvx branch feature
gvx checkout feature
```

GVX also supports `gvx add <file-or-folder>` and `gvx diff`. It skips `.git`, `.gvx`, `node_modules`, and `.next`, and reads ignore patterns from `.gitignore` and `.gvxignore`.

`gvx push` is not available yet. A custom remote server and push API must be implemented before GVX can send its commits elsewhere; GitHub and Git remotes cannot read the custom `.gvx` format.
