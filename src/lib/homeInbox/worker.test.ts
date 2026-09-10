import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeDecision,
  deliverSavedDecision,
  type DecisionRun,
  type DecisionWorkerDependencies,
} from "./worker";
import { HomeInboxError } from "./contracts";
import { claim, item, now, profile } from "./fixtures.test-support";

function fixture() {
  const rows = new Map<string, DecisionRun>();
  const calls = { claims: 0, models: 0, deliveries: 0, errors: [] as string[] };
  const deps: DecisionWorkerDependencies = {
    now: () => now,
    authorize: async () => profile,
    home: {
      list: async () => [item],
      claim: async () => {
        calls.claims++;
        return claim();
      },
      complete: async () => {
        calls.deliveries++;
        return { applied: true };
      },
    },
    execute: async () => {
      calls.models++;
      return '{"outcome_key":"keep","summary":null}';
    },
    store: {
      reserve: async (metadata) => {
        if (rows.has(metadata.id)) return null;
        const row: DecisionRun = {
          id: metadata.id,
          decisionId: metadata.id,
          claimKey: "fixed-claim-key",
          traceId: "fixed-trace",
          state: "claiming",
          expiresAt: metadata.expires_at,
          claim: null,
          result: null,
          deliveryAttempts: 0,
        };
        rows.set(metadata.id, row);
        return row;
      },
      begin: async (run, payload) => {
        if (run.state !== "claiming") return false;
        run.state = "running";
        run.claim = payload;
        return true;
      },
      saveResult: async (run, result) => {
        if (run.state !== "running") return false;
        run.result = result;
        run.state = "completed";
        return true;
      },
      finish: async (run, state, code) => {
        if (["running", "claiming"].includes(run.state)) run.state = state;
        calls.errors.push(code);
      },
      delivered: async (run) => {
        run.state = "delivered";
      },
      deferReceipt: async (run, code) => {
        run.deliveryAttempts++;
        calls.errors.push(code);
      },
    },
  };
  return { deps, rows, calls };
}
test("parallel polls execute exactly one model and persist before delivery", async () => {
  const { deps, rows, calls } = fixture();
  deps.home.complete = async () => {
    assert.equal(rows.get(item.id)?.state, "completed");
    assert.equal(rows.get(item.id)?.result?.usage, null);
    calls.deliveries++;
    return { applied: true };
  };
  const result = await Promise.all(
    Array.from({ length: 20 }, () => consumeDecision(item, deps)),
  );
  assert.equal(result.filter((state) => state === "delivered").length, 1);
  assert.equal(
    result.filter((state) => state === "already_reserved").length,
    19,
  );
  assert.equal(calls.claims, 1);
  assert.equal(calls.models, 1);
  assert.equal(calls.deliveries, 1);
});
test("lost claim acknowledgement is held; it never causes another claim/model", async () => {
  const { deps, calls, rows } = fixture();
  deps.home.claim = async () => {
    calls.claims++;
    throw new HomeInboxError("home_request_uncertain", "lost");
  };
  assert.equal(await consumeDecision(item, deps), "unknown");
  assert.equal(await consumeDecision(item, deps), "already_reserved");
  assert.equal(rows.get(item.id)?.state, "unknown");
  assert.equal(calls.claims, 1);
  assert.equal(calls.models, 0);
});
test("execute:false never starts a model", async () => {
  const { deps, calls } = fixture();
  deps.home.claim = async () => ({
    decision_id: item.id,
    execute: false,
    status: "claimed",
  });
  assert.equal(await consumeDecision(item, deps), "not_claimed");
  assert.equal(calls.models, 0);
});
test("a failed or lost execution barrier cannot start a harness invocation", async () => {
  for (const mode of ["throw", "cas_failed"]) {
    const { deps, calls } = fixture();
    deps.store.begin = async () => {
      if (mode === "throw") throw new Error("storage unavailable");
      return false;
    };
    await consumeDecision(item, deps);
    assert.equal(calls.models, 0);
    assert.equal(calls.deliveries, 0);
  }
});
test("permission removal between claim and model fails closed", async () => {
  const { deps, calls } = fixture();
  let checks = 0;
  deps.authorize = async () => {
    if (++checks > 1)
      throw new HomeInboxError("profile_admin_required", "revoked");
    return profile;
  };
  assert.equal(await consumeDecision(item, deps), "unknown");
  assert.equal(calls.claims, 1);
  assert.equal(calls.models, 0);
});
test("already expired input is not reserved and near-expired claims cannot execute", async () => {
  const { deps, calls, rows } = fixture();
  assert.equal(
    await consumeDecision(
      { ...item, expires_at: new Date(now).toISOString() },
      deps,
    ),
    "expired",
  );
  assert.equal(rows.size, 0);
  deps.home.claim = async () => ({
    ...claim(),
    expires_at: new Date(now + 3000).toISOString(),
  });
  assert.equal(await consumeDecision(item, deps), "unknown");
  assert.equal(calls.models, 0);
});
test("a model error or malformed/expired output is not auto-rerun or delivered", async () => {
  for (const mode of ["throw", "bad_json", "extra_action", "expired"]) {
    const { deps, calls, rows } = fixture();
    deps.execute = async () => {
      calls.models++;
      if (mode === "throw") throw new Error("provider token private");
      if (mode === "bad_json") return "maybe keep";
      if (mode === "extra_action")
        return '{"outcome_key":"keep","summary":null,"send":"Hi"}';
      deps.now = () => now + 660_000;
      return '{"outcome_key":"keep","summary":null}';
    };
    assert.equal(await consumeDecision(item, deps), "unknown");
    deps.now = () => now;
    assert.equal(await consumeDecision(item, deps), "already_reserved");
    assert.equal(rows.get(item.id)?.state, "unknown");
    assert.equal(calls.models, 1);
    assert.equal(calls.deliveries, 0);
    assert.ok(calls.errors.every((value) => !value.includes("private")));
  }
});
test("uncertain save acknowledgement recovers the persisted result, not another model", async () => {
  const { deps, rows, calls } = fixture();
  const save = deps.store.saveResult;
  deps.store.saveResult = async (run, result) => {
    await save(run, result);
    throw new Error("connection lost after commit");
  };
  assert.equal(await consumeDecision(item, deps), "unknown");
  const saved = rows.get(item.id)!;
  assert.equal(saved.state, "completed");
  assert.equal(await deliverSavedDecision(saved, deps), "delivered");
  assert.equal(calls.models, 1);
});
test("lost completion response retries only identical saved receipt and original token", async () => {
  const { deps, rows, calls } = fixture();
  const receipts: unknown[] = [];
  deps.home.complete = async (...args) => {
    receipts.push(args);
    if (receipts.length === 1) throw new Error("ack lost");
    return { applied: true };
  };
  assert.equal(await consumeDecision(item, deps), "receipt_pending");
  assert.equal(
    await deliverSavedDecision(rows.get(item.id)!, deps),
    "delivered",
  );
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(calls.models, 1);
});
test("paused binding holds a saved receipt without deleting it", async () => {
  const { deps, rows, calls } = fixture();
  deps.home.complete = async () => {
    throw new Error("ack lost");
  };
  await consumeDecision(item, deps);
  deps.authorize = async () => {
    throw new HomeInboxError("binding_inactive", "paused");
  };
  assert.equal(
    await deliverSavedDecision(rows.get(item.id)!, deps),
    "receipt_pending",
  );
  assert.equal(rows.get(item.id)?.state, "completed");
  assert.equal(calls.models, 1);
});
test("a stale receipt recorded by Home is not represented as an applied flow decision", async () => {
  const { deps } = fixture();
  deps.home.complete = async () => ({ applied: false });
  assert.equal(await consumeDecision(item, deps), "recorded_not_applied");
});
