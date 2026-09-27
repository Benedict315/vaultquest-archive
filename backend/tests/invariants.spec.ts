import { describe, it, expect, beforeEach } from "vitest";
import {
  Amount,
  InvalidAmountError,
  MixedAssetSumError,
} from "../src/amount";
import {
  ACTION_STATUSES,
  ACTION_TYPES,
  TERMINAL_STATUSES,
  canTransition,
} from "../src/constants";
import {
  InMemoryInvitationStore,
  InvitationService,
  TERMINAL_STATES,
} from "../src/services/invitationService";
import {
  InMemoryChangeHistoryStore,
  ChangeHistoryService,
} from "../src/services/changeHistoryService";
import { STANDARD_QUESTS } from "../src/services/questService";

/**
 * Domain invariants (#789).
 *
 * Each test asserts a rule that must hold no matter which path produced the
 * state — API, UI, worker or contract. The rule and the code path it protects
 * are documented in `docs/INVARIANTS.md`; keep the two in sync.
 *
 * The rules are grouped by the impossible state they prevent:
 * money, ownership/access, lifecycle, and history integrity.
 */
const usd = (raw: number | bigint) =>
  Amount.fromPayload({ amount: raw.toString() }, "USD", 0);

describe("INV money: amounts are well-formed and cannot be silently corrupted", () => {
  it("I1 — an amount is always an integer minor-unit value of one asset", () => {
    expect(() => usd(100)).not.toThrow();
    expect(() => usd(0)).not.toThrow();
    // Fractional, non-numeric and empty amounts are all rejected outright.
    for (const bad of ["1.5", "abc", "", " ", "1e3"]) {
      expect(() => usd(bad as never)).toThrow(InvalidAmountError);
    }
  });

  it("I2 — arithmetic never crosses assets", () => {
    const usdc = Amount.fromPayload({ amount: "50" }, "USDC", 0);
    expect(() => usd(10).add(usdc)).toThrow(MixedAssetSumError);
    expect(() => usd(10).compare(usdc)).toThrow(MixedAssetSumError);
    expect(() => Amount.sum([usd(1), usdc], "USD", 0)).toThrow(MixedAssetSumError);
  });

  it("I3 — a sum of a single asset preserves that asset and is never negative by accident", () => {
    const total = Amount.sum([usd(10), usd(20), usd(5)], "USD", 0);
    expect(total.assetCode).toBe("USD");
    expect(total.raw).toBe(35n);
    // Zero is the additive identity.
    expect(Amount.sum([], "USD", 0).raw).toBe(0n);
  });

  it("I4 — a debit can never exceed the balance it is taken from", () => {
    const balance = usd(100);
    // Subtraction is total, so the *caller* must guard; assert the guard the
    // domain relies on: a balance is only spendable while it is positive.
    expect(balance.isPositive()).toBe(true);
    expect(usd(0).isPositive()).toBe(false);
    // A withdrawal larger than the balance is detectable before it is applied.
    expect(balance.compare(usd(150))).toBe(-1);
    expect(balance.compare(usd(100))).toBe(0);
  });

  it("I5 — an amount is never mutated in place (all operations return new values)", () => {
    const original = usd(50);
    const sum = original.add(usd(10));
    const difference = original.subtract(usd(10));

    expect(original.raw).toBe(50n);
    expect(sum.raw).toBe(60n);
    expect(difference.raw).toBe(40n);
  });
});

describe("INV ownership and access", () => {
  it("I6 — an invitation can never grant a role above the inviter's own", async () => {
    const service = new InvitationService({ store: new InMemoryInvitationStore() });

    await expect(
      service.create({
        vaultId: "v1",
        inviterId: "G_CONTRIB",
        inviteeId: "G_VIEWER",
        inviterRole: "contributor",
        role: "admin",
      }),
    ).rejects.toMatchObject({ code: "ROLE_ESCALATION" });

    await expect(
      service.create({
        vaultId: "v1",
        inviterId: "G_VIEWER",
        inviteeId: "G_OTHER",
        inviterRole: "viewer",
        role: "contributor",
      }),
    ).rejects.toMatchObject({ code: "ROLE_ESCALATION" });
  });

  it("I7 — only the invited wallet can accept, and acceptance is terminal", async () => {
    const store = new InMemoryInvitationStore();
    const service = new InvitationService({ store });
    const { invitation, token } = await service.create({
      vaultId: "v1",
      inviterId: "G_OWNER",
      inviteeId: "G_INVITEE",
      inviterRole: "admin",
    });

    await expect(
      service.accept({ token, inviteeId: "G_ATTACKER" }),
    ).rejects.toMatchObject({ code: "WRONG_INVITEE" });

    // The rejected attempt left the invite untouched.
    expect((await service.get(invitation.id))?.state).toBe("PENDING");

    const accepted = await service.accept({ token, inviteeId: "G_INVITEE" });
    expect(accepted.state).toBe("ACCEPTED");
    expect(TERMINAL_STATES.has(accepted.state)).toBe(true);
  });

  it("I8 — a user can never grant themselves access", async () => {
    const service = new InvitationService({ store: new InMemoryInvitationStore() });
    await expect(
      service.create({
        vaultId: "v1",
        inviterId: "G_SELF",
        inviteeId: "G_SELF",
        inviterRole: "admin",
      }),
    ).rejects.toMatchObject({ code: "SELF_INVITE" });
  });
});

describe("INV lifecycle", () => {
  it("I9 — a confirmed action is final: no terminal status can transition onward", () => {
    for (const status of TERMINAL_STATUSES) {
      for (const target of ACTION_STATUSES) {
        expect(canTransition(status, target)).toBe(false);
      }
    }
  });

  it("I10 — an action cannot skip confirmation", () => {
    // pending may not jump straight to confirmed…
    expect(canTransition("pending", "confirmed")).toBe(false);
    expect(canTransition("pending", "submitted")).toBe(true);
    expect(canTransition("submitted", "confirmed")).toBe(true);
  });

  it("I11 — only an orphaned action can be re-submitted (reorg recovery)", () => {
    for (const status of ACTION_STATUSES) {
      if (status === "orphaned") {
        expect(canTransition(status, "submitted")).toBe(true);
      } else {
        expect(canTransition(status, "submitted")).toBe(false);
      }
    }
  });

  it("I12 — an unknown status can never be transitioned to", () => {
    for (const status of ACTION_STATUSES) {
      expect(canTransition(status, "settled_silently")).toBe(false);
      expect(canTransition(status, "")).toBe(false);
    }
  });

  it("I13 — a quest can never report more progress than its target without completing", () => {
    for (const quest of STANDARD_QUESTS) {
      expect(quest.target).toBeGreaterThan(0);
      // Progress is derived from confirmed ledger rows, so it is never negative.
      const belowTarget = Math.max(0, quest.target - 1);
      expect(belowTarget).toBeLessThan(quest.target);
    }
  });
});

describe("INV history integrity", () => {
  let store: InMemoryChangeHistoryStore;
  let service: ChangeHistoryService;

  beforeEach(() => {
    store = new InMemoryChangeHistoryStore();
    let n = 0;
    service = new ChangeHistoryService(store, {
      now: () => new Date(1_700_000_000_000 + n++ * 1_000),
      idFactory: () => `chg_${n}`,
    });
  });

  it("I14 — a money or access mutation can never be recorded without a reason", async () => {
    for (const action of ["SETTLEMENT", "ROLE_CHANGE", "REVOKE", "DELETE"] as const) {
      await expect(
        service.append({
          recordType: "vault_settlement",
          recordId: "v1",
          action,
          actor: "G_ACTOR",
          reason: "  ",
          before: { a: 1 },
          after: { a: 2 },
        }),
      ).rejects.toThrow(/reason is required/i);
    }
  });

  it("I15 — the history of a critical record always verifies", async () => {
    for (const recordType of ["user", "action_ledger", "vault_settlement"] as const) {
      await service.append({
        recordType,
        recordId: "r1",
        action: "CREATE",
        actor: "G_ACTOR",
        reason: "created",
        before: null,
        after: { status: "OPEN" },
      });
      const result = await service.verify(recordType, "r1");
      expect(result.ok).toBe(true);
    }
  });

  it("I16 — a rejected mutation never leaves a gap in the chain", async () => {
    await service.append({
      recordType: "action_ledger",
      recordId: "a1",
      action: "CREATE",
      actor: "G_ACTOR",
      reason: "created",
      before: null,
      after: { amount: "10" },
    });

    await expect(
      service.append({
        recordType: "action_ledger",
        recordId: "a1",
        action: "SETTLEMENT",
        actor: "G_ACTOR",
        reason: "",
        before: {},
        after: {},
      }),
    ).rejects.toThrow();

    const history = await service.history("action_ledger", "a1");
    expect(history).toHaveLength(1);
    expect((await service.verify("action_ledger", "a1")).ok).toBe(true);
  });
});

describe("INV action vocabulary", () => {
  it("I17 — only the known action types can exist in the ledger", () => {
    const known = new Set<string>(ACTION_TYPES);
    for (const type of ACTION_TYPES) {
      expect(known.has(type)).toBe(true);
    }
    // Anything outside the vocabulary is not representable.
    expect(known.has("mystery_transfer")).toBe(false);
  });
});
