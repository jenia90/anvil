# anvil

A local "push, test, learn" site for CodeCrafters-style course repos. It hosts a git remote on localhost,
runs the course's tester on every push, streams the result back into your `git push` output, and shows the
stage instructions and results on a web page.

Any course published in the [codecrafters-io](https://github.com/codecrafters-io) GitHub org works (redis, shell,
git, sqlite, interpreter, http-server, claude-code, ...): name its slug in the config and anvil downloads the
course and its tester.

> **Unofficial.** anvil is an independent project, not affiliated with or endorsed by
> [CodeCrafters](https://codecrafters.io). It contains no CodeCrafters material: course definitions, instructions and
> starter code are downloaded from CodeCrafters' public GitHub repositories (MIT-licensed), and testers from the
> GitHub releases of their tester repositories, at the moment you use them. Those testers are not open-source licensed;
> they and the courses remain CodeCrafters', under [their terms](https://codecrafters.io/terms), which you are
> responsible for following. anvil is a local, offline-friendly runner; the CodeCrafters platform offers much more
> (hosted runs, community solutions, guidance), and if you enjoy the courses, please support them with a subscription.

Everything listens on `127.0.0.1` only and there is no login. Pushed code runs as your user.
Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are refused (DNS rebinding), and the
post-receive hook endpoint needs a token that the app writes into each repo's hook at startup.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- `git` with `git http-backend` (the `git-core` package on most systems), `curl` (the push hook uses it) and `tar`
- Network access to GitHub the first time a course is used (Linux or macOS, amd64 or arm64: the testers'
  release builds)
- The toolchain your solution needs (cargo, go, ...). Code runs on your machine, not in CodeCrafters' containers.

## Run it

```sh
bun install
cp anvil.example.yml anvil.yml   # then edit repos
bun run start                          # or: bun run src/main.ts path/to/config.yml
```

`anvil.yml` is gitignored, so your local paths stay out of the repo. See `anvil.example.yml` for every setting
(`port`, `dataDir`, `repos`, `courses`).

Each repo names a course slug (the `<slug>` in `build-your-own-<slug>`) and the language you are using:

```yaml
repos:
  - name: redis-rust
    course: redis
    language: rust
```

On start, anvil downloads any course it does not have yet; that takes a few seconds per course. To pick up newer
course text and tester releases later:

```sh
bun run start --update
```

A failed update keeps the copy already on disk. Unauthenticated GitHub API calls are rate limited (60 per hour);
set `GITHUB_TOKEN` if you hit that.

The app prints its URL and, for each repo, the commands to connect your solution repo:

```sh
git remote add local http://127.0.0.1:4300/git/<repo>.git
git push local HEAD:main
```

Your existing remotes (for example `origin`) are not touched.

## Use anvil from your other devices

anvil listens on `127.0.0.1` only. To reach it from your laptop or phone, keep it that way and put
[Tailscale](https://tailscale.com) in front: your devices reach it over your private tailnet, and nothing is
exposed to your network or the internet. anvil runs whatever code is pushed to it and has no login, so do not
put it on a public address.

1. In the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS Certificates (once per tailnet).
2. On the machine running anvil: `tailscale serve --bg 4300`. It prints the address, e.g.
   `https://my-machine.my-tailnet.ts.net`.
3. Add that address to `anvil.yml` and restart anvil:

   ```yaml
   url: https://my-machine.my-tailnet.ts.net
   ```

anvil then accepts requests for that host name (the Host and Origin checks still refuse everything else) and
uses the address in every command and link it shows, so a `git clone` copied on another device works there.
`http://127.0.0.1:4300` keeps working on the machine itself. To stop sharing: `tailscale serve --https=443 off`.

## Start a new course

Open `http://127.0.0.1:4300/courses`, pick a course, pick your language and press **Start**. anvil downloads the
course if needed and creates `<course>-<language>` with one commit holding CodeCrafters' starter code for that
language, as on the CodeCrafters website. The page then shows what to run:

```sh
git clone http://127.0.0.1:4300/git/sqlite-rust.git codecrafters-sqlite-rust
cd codecrafters-sqlite-rust
# write code, commit
git push origin main                  # every push runs the tests
```

The repo is added to `anvil.yml` (comments kept) and works right away, without a restart. From a terminal, with
anvil running:

```sh
bun run new sqlite rust              # or: bun run new <course> <language> [dir] [--config path/to/anvil.yml]
```

does the same and clones the repo to `codecrafters-sqlite-rust` beside the anvil folder (or to `dir`).

The catalog lists the CodeCrafters courses that are live, in beta or in early access, read from GitHub and cached
in `dataDir/catalog.json` for a day (`--update` refreshes it). If GitHub cannot be reached, the saved catalog is
shown.

## Where data lives

`dataDir` (default `./data`, beside the config file) holds one bare git repo per registered repo
(`repos/<repo>.git`), the run history in `anvil.sqlite`, and the downloaded courses in `courses/<slug>/`:
`course/` (the definition, stage instructions and per-language starters from `build-your-own-<slug>`), `tester/` (the release of
`<slug>-tester`) and `tester-version`; and the course catalog in `catalog.json`. History survives restarts. Delete the folder to start from scratch, or
`courses/<slug>` to download one course again.

## What happens on a push

1. Each updated branch gets a run (tags and branch deletions are ignored; a push is always accepted).
2. The commit is checked out and prepared as CodeCrafters does: `.codecrafters/compile.sh` runs if present, and
   `.codecrafters/run.sh` (if present) replaces `your_program.sh`. Then the course tester runs, with `TESTER_DIR`
   set to the tester's folder.
3. The first push of a repo runs every stage; later pushes run stages 1 up to the current stage.
4. Output streams back as `remote:` lines and live into the strip at the bottom of the stage page.
   Click the strip to open the failure details.
5. The current stage is the first stage whose latest result is not a pass.

Runs for one course are queued one at a time (the tester and build output use fixed ports and paths).

## The web pages

- `/` lists your repos with their course and current stage, and links to the course catalog.
- `/courses` lists the courses; `/courses/<slug>` shows a course's description and stages, the repos you already
  started for it, and the language picker with **Start**.
- `/r/<repo>` opens the current stage; `/r/<repo>/<n>` opens stage `n`.
- A stage page has the stage list on the left (done, current, upcoming; extension stages grouped under their
  extension's name), the instructions for your repo's language in the middle, and a strip along the bottom with the latest push: short commit hash, branch and state.
  The strip updates live while a run is queued, building or testing.
- Click the strip to open a flyout with the details: for a failed run, each failed stage's tester log with the failing
  line highlighted; for a build failure, the compile output; for a pass, a link to the next stage.
- Until a repo has had its first push, the page shows what to run: `git clone` for a course started from anvil,
  or `git remote add` for an existing repo you registered by hand.

## Limits

- Each phase of a run (compile, tester) is killed after 10 minutes and the run ends as `error`
  (`DEFAULT_TIMEOUT_MS` in `src/runner.ts`).
- A run that was still queued, building or testing when the app stopped is marked `error` on the next start.
- Stored logs are capped at about 1 MiB per phase; the tester's own result lines are always kept.
- Extensions are not optional: their stages follow the base stages in the order the course definition lists them,
  and the current stage is the first one not passing. Every push re-runs all stages up to the current one, as on
  CodeCrafters.
- Some courses need more from your machine. The `claude-code` tester calls OpenRouter with your own key: export
  `CODECRAFTERS_SECRET_OPENROUTER_API_KEY` before `bun run start` (usage is billed to that key). The `docker` course
  needs root and Linux namespaces.
- Removing a repo is by hand: delete its entry from `anvil.yml` and `dataDir/repos/<repo>.git`, then restart.
- Testers run as you, never as root. Some testers move system programs aside so a solution cannot call them
  (`grep` for the grep course, `pwd` for the shell course, with `sudo` if needed). anvil gives each test run its
  own copies of those on `PATH` and a `sudo` that runs as you, so your system is never touched. The flip side: the
  testers' check that your solution does not call the system `grep` or `pwd` does not work locally.
- The starter is the course's compiled starter for your language, as CodeCrafters hands it out: the first stage
  fails until you write the code.

## Adding a course

Add a `repos:` entry with the course slug; anvil downloads it on the next start.

To use a course from local paths instead (a course you are writing, or a tester you built yourself), add a
`courses:` entry. `definition` is a course repo folder (`course-definition.yml` plus `stage_descriptions/`) or a
single-file definition with `description_md` on each stage; `tester` is the tester binary. Local entries win over
downloads for the same slug.

## Development

```sh
bun test
```

## License

anvil's own code is MIT-licensed (see `LICENSE`). That licence does not cover anything anvil downloads.
