import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  isCheckoutCredentialIncludePath,
  scrubLocalGitAuthConfig,
} from "../src/main.ts";

const projectRoot = process.cwd();
const sourceMainUrl = pathToFileURL(join(projectRoot, "src/main.ts")).href;
const tsxLoaderUrl = pathToFileURL(
  join(projectRoot, "node_modules/tsx/dist/loader.mjs"),
).href;
const emptyGlobalConfig = join(tmpdir(), "setup-git-credentials-empty-gitconfig");
writeFileSync(emptyGlobalConfig, "");

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyGlobalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function createRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "setup-git-credentials-test-")));
  git(["init"], dir);
  return dir;
}

function readConfig(key, cwd) {
  try {
    return git(["config", "--local", "--get-all", key], cwd);
  } catch (error) {
    if (error.status === 1) return "";
    throw error;
  }
}

function withRunnerTemp() {
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  const runnerTemp = realpathSync(mkdtempSync(join(tmpdir(), "runner-temp-")));
  process.env.RUNNER_TEMP = runnerTemp;

  return {
    runnerTemp,
    restore() {
      if (previousRunnerTemp === undefined) {
        delete process.env.RUNNER_TEMP;
      } else {
        process.env.RUNNER_TEMP = previousRunnerTemp;
      }
      rmSync(runnerTemp, { force: true, recursive: true });
    },
  };
}

async function inRepo(callback) {
  const previousCwd = process.cwd();
  const repo = createRepo();

  process.chdir(repo);
  try {
    await callback(repo);
  } finally {
    process.chdir(previousCwd);
    rmSync(repo, { force: true, recursive: true });
  }
}

test("direct local http extraheader cleanup still works", async () => {
  await inRepo(async (repo) => {
    git(
      [
        "config",
        "--local",
        "http.https://github.com/.extraheader",
        "AUTHORIZATION: basic token-value",
      ],
      repo,
    );

    await scrubLocalGitAuthConfig(new URL("https://github.com"));

    assert.equal(readConfig("http.https://github.com/.extraheader", repo), "");
  });
});

test("checkout v6 includeIf credential config is removed", async () => {
  const { runnerTemp, restore } = withRunnerTemp();
  try {
    await inRepo(async (repo) => {
      const checkoutConfig = join(runnerTemp, "git-credentials-1234.config");
      const userConfig = join(repo, "user-include.config");
      writeFileSync(checkoutConfig, "[http \"https://github.com/\"]\n\textraheader = secret\n");
      writeFileSync(userConfig, "[user]\n\tname = Example\n");
      const key = `includeIf.gitdir:${repo}/.git.path`;
      git(["config", "--local", key, checkoutConfig], repo);
      git(["config", "--local", "--add", key, userConfig], repo);

      await scrubLocalGitAuthConfig(new URL("https://github.com"));

      assert.equal(readConfig(key, repo), userConfig);
    });
  } finally {
    restore();
  }
});

test("unrelated includeIf entries are preserved", async () => {
  await inRepo(async (repo) => {
    const configPath = join(repo, "user-include.config");
    writeFileSync(configPath, "[user]\n\tname = Example\n");
    const key = `includeIf.gitdir:${repo}/.git.path`;
    git(["config", "--local", key, configPath], repo);

    await scrubLocalGitAuthConfig(new URL("https://github.com"));

    assert.equal(readConfig(key, repo), configPath);
  });
});

test("includeIf outside runner temp or without checkout credential filename is preserved", async () => {
  const { runnerTemp, restore } = withRunnerTemp();
  try {
    await inRepo(async (repo) => {
      const outsidePath = join(repo, "git-credentials-outside.config");
      const wrongName = join(runnerTemp, "regular-git-config.config");
      writeFileSync(outsidePath, "[user]\n\tname = Example\n");
      writeFileSync(wrongName, "[user]\n\temail = example@example.com\n");
      const outsideKey = `includeIf.gitdir:${repo}/.git.path`;
      const wrongNameKey = `includeIf.gitdir:${repo}/.git/worktrees/*.path`;
      git(["config", "--local", outsideKey, outsidePath], repo);
      git(["config", "--local", wrongNameKey, wrongName], repo);

      await scrubLocalGitAuthConfig(new URL("https://github.com"));

      assert.equal(readConfig(outsideKey, repo), outsidePath);
      assert.equal(readConfig(wrongNameKey, repo), wrongName);
    });
  } finally {
    restore();
  }
});

test("embedded remote.origin.url credentials for configured host are cleaned", async () => {
  await inRepo(async (repo) => {
    git(
      [
        "config",
        "--local",
        "remote.origin.url",
        "https://x-access-token:secret-token@github.com/owner/repo.git",
      ],
      repo,
    );

    await scrubLocalGitAuthConfig(new URL("https://github.com"));

    assert.equal(
      readConfig("remote.origin.url", repo),
      "https://github.com/owner/repo.git",
    );
  });
});

test("clean and non-configured host remote.origin.url values are unchanged", async () => {
  await inRepo(async (repo) => {
    git(["config", "--local", "remote.origin.url", "https://github.com/owner/repo.git"], repo);

    await scrubLocalGitAuthConfig(new URL("https://github.com"));

    assert.equal(
      readConfig("remote.origin.url", repo),
      "https://github.com/owner/repo.git",
    );
  });

  await inRepo(async (repo) => {
    const remoteUrl = "https://token:secret@gitlab.com/owner/repo.git";
    git(["config", "--local", "remote.origin.url", remoteUrl], repo);

    await scrubLocalGitAuthConfig(new URL("https://github.com"));

    assert.equal(readConfig("remote.origin.url", repo), remoteUrl);
  });
});

test("debug output does not print token or auth header values", async () => {
  const { runnerTemp, restore } = withRunnerTemp();

  try {
    await inRepo(async (repo) => {
      const checkoutConfig = join(runnerTemp, "git-credentials-secret.config");
      writeFileSync(
        checkoutConfig,
        "[http \"https://github.com/\"]\n\textraheader = AUTHORIZATION: basic very-secret-header\n",
      );
      git(
        [
          "config",
          "--local",
          `includeIf.gitdir:${repo}/.git.path`,
          checkoutConfig,
        ],
        repo,
      );
      git(
        [
          "config",
          "--local",
          "remote.origin.url",
          "https://x-access-token:very-secret-token@github.com/owner/repo.git",
        ],
        repo,
      );

      const script = [
        `import { scrubLocalGitAuthConfig } from ${JSON.stringify(sourceMainUrl)};`,
        'await scrubLocalGitAuthConfig(new URL("https://github.com"));',
      ].join("\n");

      const output = execFileSync(
        process.execPath,
        ["--import", tsxLoaderUrl, "--input-type=module", "-e", script],
        {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: emptyGlobalConfig,
            GIT_CONFIG_NOSYSTEM: "1",
            RUNNER_TEMP: runnerTemp,
          },
        },
      );

      assert.match(output, new RegExp(basename(runnerTemp)));
      assert.doesNotMatch(output, /very-secret-token/);
      assert.doesNotMatch(output, /very-secret-header/);
      assert.doesNotMatch(output, /x-access-token:very-secret-token/);
    });
  } finally {
    restore();
  }
});

test("checkout include path matcher accepts clear runner temp paths without RUNNER_TEMP", () => {
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  delete process.env.RUNNER_TEMP;

  try {
    assert.equal(
      isCheckoutCredentialIncludePath(
        "/home/runner/_work/_temp/git-credentials-1234.config",
      ),
      true,
    );
  } finally {
    if (previousRunnerTemp !== undefined) process.env.RUNNER_TEMP = previousRunnerTemp;
  }
});
