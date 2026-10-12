const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CODEX_NETWORK_ENV_KEYS,
  chooseCodexNetworkEnvironmentSource,
  parseEnvironment,
} = require("../dist/codexSpawnEnvironment.js");

test("parses proc environment values without losing embedded equals signs", () => {
  const env = parseEnvironment(
    Buffer.from("HTTP_PROXY=http://user:pass@127.0.0.1:8080\0TOKEN=a=b=c\0"),
  );

  assert.equal(env.HTTP_PROXY, "http://user:pass@127.0.0.1:8080");
  assert.equal(env.TOKEN, "a=b=c");
});

test("prefers the official Codex sibling owned by the current extension host", () => {
  const selected = chooseCodexNetworkEnvironmentSource(
    [
      {
        pid: 200,
        ppid: 999,
        args: ["/opt/codex", "-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
        environment: { HTTP_PROXY: "http://other" },
      },
      {
        pid: 100,
        ppid: 123,
        args: ["/opt/codex", "-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
        environment: { HTTP_PROXY: "http://same-parent", HTTPS_PROXY: "http://same-parent" },
      },
    ],
    123,
  );

  assert.equal(selected.pid, 100);
});

test("network environment allowlist excludes authentication and originator variables", () => {
  assert.equal(CODEX_NETWORK_ENV_KEYS.includes("HTTP_PROXY"), true);
  assert.equal(CODEX_NETWORK_ENV_KEYS.includes("HTTPS_PROXY"), true);
  assert.equal(CODEX_NETWORK_ENV_KEYS.includes("OPENAI_API_KEY"), false);
  assert.equal(CODEX_NETWORK_ENV_KEYS.includes("CODEX_ACCESS_TOKEN"), false);
  assert.equal(CODEX_NETWORK_ENV_KEYS.includes("CODEX_INTERNAL_ORIGINATOR_OVERRIDE"), false);
});
