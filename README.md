# Setup Git Credentials

Configure later raw `git` commands in a GitHub Actions job to use an explicit
token through job-scoped runtime credentials.

This action is intended for workflows where `gh` may already be authenticated
correctly, but raw `git push` can still be hijacked by stale runner Git config,
checkout extraheaders, credential helpers, or tokenized URL rewrites.

## Usage

Before raw `git push`:

```yml
- uses: kostua16/setup-git-credentials@v1
  with:
    token: ${{ secrets.GH_PAT }}
- run: git push origin HEAD
```

After switching `gh` to a PAT:

```yml
- uses: kostua16/setup-gh@v1
  with:
    token: ${{ secrets.GH_PAT }}
    cli-token: ${{ secrets.GH_PAT }}
    switch-account: true
- uses: kostua16/setup-git-credentials@v1
  with:
    token: ${{ secrets.GH_PAT }}
```

Switch raw Git auth more than once in the same job:

```yml
- uses: kostua16/setup-git-credentials@v1
  with:
    token: ${{ secrets.FIRST_PAT }}
- run: git push origin HEAD:first-branch

- uses: kostua16/setup-git-credentials@v1
  with:
    token: ${{ secrets.SECOND_PAT }}
- run: git push origin HEAD:second-branch
```

## Inputs

- **`token`:** Required token for later raw `git` commands. No default is
  provided so callers choose the exact credential source.
- **`github-server-url`:** GitHub server URL to configure. Defaults to
  `${{ github.server_url }}`.

## Behavior

- Exports `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_GLOBAL`, and
  `GIT_CONFIG_NOSYSTEM=1` for later job steps.
- Stores the token only in a masked job environment variable used by askpass.
- Uses `x-access-token` as the Git username.
- Creates temp askpass and Git config files under `RUNNER_TEMP`.
- Clears stale checkout-local GitHub `credential.helper`,
  `http.*.extraheader`, and `url.*.insteadOf` entries for the configured host.
- Clears checkout v6 local `includeIf.gitdir:*` entries that point to
  `RUNNER_TEMP` `git-credentials-*.config` files, including worktree patterns.
- Sanitizes local `remote.origin.url` when it targets the configured GitHub host
  with embedded username/password credentials.
- Adds non-tokenized SSH-to-HTTPS rewrites for the configured host.
- Never writes tokenized URLs or mutates user/global/system Git config.

## Development

```sh
npm ci
npm run typecheck
npm run build
```
