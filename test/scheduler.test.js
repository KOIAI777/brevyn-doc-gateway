import assert from "node:assert/strict";
import test from "node:test";

import { AccountScheduler } from "../src/scheduler.js";

test("scheduler chooses lower priority first and respects concurrency", () => {
  let now = 1000;
  const scheduler = new AccountScheduler([
    { id: "a", name: "a", enabled: true, apiKey: "k", priority: 20, maxConcurrency: 1, submitPerMinute: 10 },
    { id: "b", name: "b", enabled: true, apiKey: "k", priority: 10, maxConcurrency: 1, submitPerMinute: 10 }
  ], () => now);

  const first = scheduler.acquire();
  assert.equal(first.account.id, "b");

  const second = scheduler.acquire();
  assert.equal(second.account.id, "a");

  assert.equal(scheduler.acquire(), null);

  first.release("success");
  now += 1;
  const third = scheduler.acquire();
  assert.equal(third.account.id, "b");
});

test("scheduler skips accounts in cooldown", () => {
  let now = 1000;
  const scheduler = new AccountScheduler([
    { id: "a", name: "a", enabled: true, apiKey: "k", priority: 1, maxConcurrency: 1, submitPerMinute: 10 },
    { id: "b", name: "b", enabled: true, apiKey: "k", priority: 2, maxConcurrency: 1, submitPerMinute: 10 }
  ], () => now);

  scheduler.cooldown("a", 1000);
  assert.equal(scheduler.acquire().account.id, "b");
  now += 1001;
  assert.equal(scheduler.acquire().account.id, "a");
});

test("scheduler enforces submit-per-minute window", () => {
  let now = 1000;
  const scheduler = new AccountScheduler([
    { id: "a", name: "a", enabled: true, apiKey: "k", priority: 1, maxConcurrency: 10, submitPerMinute: 1 }
  ], () => now);

  const first = scheduler.acquire();
  assert.equal(first.account.id, "a");
  first.release("success");
  assert.equal(scheduler.acquire(), null);
  now += 60_000;
  assert.equal(scheduler.acquire().account.id, "a");
});

test("scheduler allows token-free flash accounts but requires key for precision", () => {
  const scheduler = new AccountScheduler([
    { id: "flash", name: "flash", enabled: true, mode: "flash", tokenRequired: false, apiKey: "", priority: 1, maxConcurrency: 1, submitPerMinute: 10 },
    { id: "precision", name: "precision", enabled: true, mode: "precision", tokenRequired: true, apiKey: "", priority: 1, maxConcurrency: 1, submitPerMinute: 10 }
  ]);

  assert.equal(scheduler.acquire(new Set(), { mode: "flash" }).account.id, "flash");
  assert.equal(scheduler.acquire(new Set(), { mode: "precision" }), null);
});
