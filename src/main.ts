import * as core from "@actions/core";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";

const gitTokenEnvName = "SETUP_GIT_CREDENTIALS_TOKEN";
const gitAuthConfigPattern =
  "^(credential\\.helper|http(\\..*)?\\.extraheader|url\\..*\\.insteadof)$";

type GitConfigEntry = {
  key: string;
  value: string;
};

function createGitCredentialDir() {
  return mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "setup-git-credentials-"),
  );
}

function escapeGitConfigSubsection(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function createAskpassScript(gitCredentialDir: string) {
  const askpassPath = join(
    gitCredentialDir,
    process.platform === "win32" ? "git-askpass.cmd" : "git-askpass.sh",
  );
  const script =
    process.platform === "win32"
      ? `@echo off
setlocal EnableExtensions
set "prompt=%~1"
echo(%prompt%| findstr /I "Username" >nul
if not errorlevel 1 (
  echo x-access-token
  exit /b 0
)
echo(%prompt%| findstr /I "Password" >nul
if not errorlevel 1 (
  echo(%${gitTokenEnvName}%
  exit /b 0
)
echo(
exit /b 0
`
      : `#!/usr/bin/env sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "\${${gitTokenEnvName}}" ;;
  *) printf '\\n' ;;
esac
`;

  writeFileSync(askpassPath, script, { mode: 0o700 });
  chmodSync(askpassPath, 0o700);
  return askpassPath;
}

function createTempGlobalGitConfig(gitCredentialDir: string, serverUrl: URL) {
  const gitConfigPath = join(gitCredentialDir, "gitconfig");
  const httpsBaseUrl = `${serverUrl.protocol}//${serverUrl.host}/`;
  const sshUrlHost = serverUrl.host;
  const sshScpHost = serverUrl.port ? serverUrl.hostname : serverUrl.host;
  const config = [
    "[credential]",
    "\thelper =",
    "",
    `[url "${escapeGitConfigSubsection(httpsBaseUrl)}"]`,
    `\tinsteadOf = git@${sshScpHost}:`,
    `\tinsteadOf = ssh://git@${sshUrlHost}/`,
    "",
  ].join("\n");

  writeFileSync(gitConfigPath, config, { mode: 0o600 });
  return gitConfigPath;
}

function sanitizeSecretBearingText(value: string) {
  return value
    .replace(/(https?:\/\/)(?:[^/\s@]+@)/gi, "$1***@")
    .replace(/(x-access-token:)[^@/\s]+/gi, "$1***")
    .replace(/(authorization:\s*(?:basic|bearer)\s+)\S+/gi, "$1***")
    .replace(/(oauth_token[:=]\s*)\S+/gi, "$1***");
}

async function debugGitAuthConfigOrigins(label: string) {
  if (!core.isDebug()) return;

  const result = await execa(
    "git",
    [
      "config",
      "--show-origin",
      "--show-scope",
      "--name-only",
      "--get-regexp",
      gitAuthConfigPattern,
    ],
    { reject: false },
  );

  if (result.exitCode === 1) {
    core.debug(`${label}: no matching git auth config entries`);
    return;
  }

  if (result.exitCode !== 0) {
    core.debug(`${label}: unable to inspect git auth config origins`);
    return;
  }

  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    core.debug(`${label}: ${sanitizeSecretBearingText(line)}`);
  }
}

async function getLocalGitConfigEntries(pattern: string): Promise<GitConfigEntry[]> {
  const result = await execa(
    "git",
    ["config", "--local", "--get-regexp", pattern],
    { reject: false },
  );

  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) {
    core.debug("Unable to inspect local git auth config entries");
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.search(/\s/);
      if (separator === -1) return { key: line, value: "" };
      return {
        key: line.slice(0, separator),
        value: line.slice(separator).trim(),
      };
    });
}

function isServerRelatedConfig(value: string, serverUrl: URL) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes(serverUrl.host.toLowerCase()) ||
    normalized.includes(serverUrl.hostname.toLowerCase())
  );
}

function shouldUnsetLocalGitAuthConfig(entry: GitConfigEntry, serverUrl: URL) {
  const key = entry.key.toLowerCase();
  if (key === "credential.helper") return true;
  if (key === "http.extraheader") return true;
  if (key.startsWith("http.") && key.endsWith(".extraheader")) {
    return isServerRelatedConfig(key, serverUrl);
  }
  if (key.startsWith("url.") && key.endsWith(".insteadof")) {
    return isServerRelatedConfig(`${entry.key} ${entry.value}`, serverUrl);
  }
  return false;
}

async function scrubLocalGitAuthConfig(serverUrl: URL) {
  const workTreeResult = await execa(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { reject: false },
  );

  if (workTreeResult.exitCode !== 0 || workTreeResult.stdout.trim() !== "true") {
    core.debug("Skipping local git auth config cleanup outside a git worktree");
    return 0;
  }

  const entries = await getLocalGitConfigEntries(gitAuthConfigPattern);
  const keysToUnset = [
    ...new Set(
      entries
        .filter((entry) => shouldUnsetLocalGitAuthConfig(entry, serverUrl))
        .map((entry) => entry.key),
    ),
  ];

  for (const key of keysToUnset) {
    const result = await execa("git", ["config", "--local", "--unset-all", key], {
      reject: false,
    });
    if (result.exitCode !== 0 && result.exitCode !== 5) {
      core.debug(
        `Unable to unset local git config key ${sanitizeSecretBearingText(key)}`,
      );
    }
  }

  return keysToUnset.length;
}

async function configureGitCredentials(serverUrl: URL, token: string) {
  core.debug("setup-git-credentials: enabled");
  await debugGitAuthConfigOrigins("git auth config before setup");

  const gitCredentialDir = createGitCredentialDir();
  const askpassPath = createAskpassScript(gitCredentialDir);
  const gitConfigPath = createTempGlobalGitConfig(gitCredentialDir, serverUrl);

  core.setSecret(token);
  core.exportVariable(gitTokenEnvName, token);
  core.exportVariable("GIT_ASKPASS", askpassPath);
  core.exportVariable("GIT_TERMINAL_PROMPT", "0");
  core.exportVariable("GIT_CONFIG_GLOBAL", gitConfigPath);
  core.exportVariable("GIT_CONFIG_NOSYSTEM", "1");

  const scrubbedLocalKeys = await scrubLocalGitAuthConfig(serverUrl);
  core.debug(`git credential temp config: ${gitConfigPath}`);
  core.debug(`git askpass script: ${askpassPath}`);
  core.debug(`local git auth config keys scrubbed: ${scrubbedLocalKeys}`);
  await debugGitAuthConfigOrigins("git auth config after setup");
}

try {
  const token = core.getInput("token", { required: true });
  const serverUrl = new URL(core.getInput("github-server-url"));
  await configureGitCredentials(serverUrl, token);
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
