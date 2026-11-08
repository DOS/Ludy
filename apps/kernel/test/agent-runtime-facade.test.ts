// SPDX-License-Identifier: AGPL-3.0-only
// The two agent facades pass what the runtime needs and no more: an org-chart agent's execute carries its idempotency key to the runtime, a
// member's background run has no such option (its stored response is a value object member mode never keeps; ADR-0049 decision 4).
import { describe, expect, it } from "vitest";
import {
  agentRuntime,
  memberVyRuntime,
  type AgentActor,
  type Runtime,
} from "@crove/kernel-runtime";

type Call = { name: string; input: unknown; options: Record<string, unknown> };

function recorder() {
  const calls: Call[] = [];
  const runtime = {
    execute: async (
      name: string,
      input: unknown,
      options: Record<string, unknown>,
    ) => {
      calls.push({ name, input, options });
      return { ok: true };
    },
    query: async () => ({}),
  } as unknown as Runtime;
  return { calls, runtime };
}

const ORG = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";

describe("agent facades", () => {
  it("passes an org-chart agent its idempotency key to the runtime", async () => {
    const { calls, runtime } = recorder();
    const actor: AgentActor = { type: "agent", agentId: AGENT, runId: RUN };
    await agentRuntime(runtime, ORG, actor).execute(
      "kernel.x",
      { a: 1 },
      { idempotencyKey: "k-1" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      orgId: ORG,
      idempotencyKey: "k-1",
      actor: { type: "agent", agentId: AGENT, runId: RUN },
    });
  });

  it("gives a member-mode run no idempotency key and flags the actor memberVy", async () => {
    const { calls, runtime } = recorder();
    const facade = memberVyRuntime(runtime, ORG, {
      agentId: AGENT,
      runId: RUN,
    });
    await (
      facade.execute as (
        name: string,
        input: unknown,
        options?: unknown,
      ) => Promise<unknown>
    )("kernel.member_vy.x", {}, { idempotencyKey: "k-2" });
    expect(calls[0]?.options).not.toHaveProperty("idempotencyKey");
    expect(calls[0]?.options).toMatchObject({
      orgId: ORG,
      actor: { type: "agent", memberVy: true },
    });
  });
});
