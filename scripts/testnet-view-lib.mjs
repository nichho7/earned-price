// Keyless, read-only NEAR testnet RPC helper for scripts/deploy.sh.
//   node scripts/testnet-view.mjs account <account_id>
//     -> {"exists":true,"amount":"<yocto>","storage_usage":<bytes>,"code_hash":"..."} or {"exists":false}
//   node scripts/testnet-view.mjs call <contract_id> <method> '<json args>'
//     -> the view function's JSON return value
// Testnet only: refuses non-.testnet accounts and any RPC outside the allowlist
// (local 127.0.0.1 is allowed so tests can run against a fake RPC).
// T-088: this is the library (tests and other scripts import it); `node scripts/testnet-view.mjs` is the CLI and always
// runs main() (same lib/CLI split as fe4e769: no "am I the main module?" check, which skipped main() via a symlink).

// Same list as cli/init.js RPC_URLS (neart.lava.build is discontinued).
const TESTNET_RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const LOCAL_RPC = /^http:\/\/127\.0\.0\.1:\d+\/?$/;

function die(msg) {
  process.stderr.write(`testnet-view: ${msg}\n`);
  process.exit(1);
}

export function rpcUrls(env = process.env) {
  const custom = env.EARNED_RPC_URL;
  if (!custom) return TESTNET_RPCS;
  if (TESTNET_RPCS.includes(custom) || LOCAL_RPC.test(custom)) return [custom];
  throw new Error(`refusing RPC ${custom}: not a known testnet RPC`);
}

// NEAR account id rules, ending in .testnet (same pattern as scripts/deploy.sh).
const TESTNET_ACCOUNT = /^[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*\.testnet$/;

export function assertTestnet(id) {
  if (typeof id !== "string" || id.length > 64 || !TESTNET_ACCOUNT.test(id)) {
    throw new Error(`refusing account ${id}: not a .testnet account`);
  }
}

async function rpc(params) {
  let lastErr;
  for (const url of rpcUrls()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "earned", method: "query", params }),
        signal: AbortSignal.timeout(15000),
      });
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`all testnet RPCs failed: ${lastErr?.message}`);
}

/** One view: `account <id>` or `call <id> <method> '<json>'`. Resolves to the JSON value printed by the CLI. */
export async function view([cmd, ...args]) {
  if (cmd === "account") {
    const [id] = args;
    assertTestnet(id);
    const out = await rpc({ request_type: "view_account", finality: "final", account_id: id });
    if (out.error) {
      const name = out.error.cause?.name;
      if (name === "UNKNOWN_ACCOUNT") return { exists: false };
      throw new Error(`RPC error: ${JSON.stringify(out.error)}`);
    }
    const r = out.result;
    return { exists: true, amount: r.amount, storage_usage: r.storage_usage, code_hash: r.code_hash };
  }
  if (cmd === "call") {
    const [id, method, json = "{}"] = args;
    assertTestnet(id);
    JSON.parse(json); // fail early on bad args
    const out = await rpc({
      request_type: "call_function",
      finality: "final",
      account_id: id,
      method_name: method,
      args_base64: Buffer.from(json).toString("base64"),
    });
    if (out.error || out.result?.error) {
      throw new Error(`view ${method} failed: ${JSON.stringify(out.error ?? out.result.error)}`);
    }
    return JSON.parse(Buffer.from(out.result.result).toString("utf8"));
  }
  throw new Error("usage: testnet-view.mjs account <id> | call <id> <method> '<json>'");
}

/** The CLI: prints the view's JSON on stdout, or `testnet-view: <error>` on stderr and exit 1. */
export function main(argv) {
  return view(argv)
    .then((v) => process.stdout.write(`${JSON.stringify(v)}\n`))
    .catch((e) => die(e.message));
}
