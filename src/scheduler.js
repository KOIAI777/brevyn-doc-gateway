export class AccountScheduler {
  constructor(accounts, now = () => Date.now()) {
    this.now = now;
    this.states = new Map();
    this.replaceAccounts(accounts);
  }

  replaceAccounts(accounts) {
    const previous = this.states || new Map();
    this.states = new Map();
    for (const account of accounts) {
      const prev = previous.get(account.id);
      this.states.set(account.id, {
        account,
        active: prev?.active || 0,
        lastUsedAt: prev?.lastUsedAt || 0,
        cooldownUntil: prev?.cooldownUntil || 0,
        minuteWindowStartedAt: prev?.minuteWindowStartedAt || 0,
        minuteSubmits: prev?.minuteSubmits || 0,
        successes: prev?.successes || 0,
        failures: prev?.failures || 0
      });
    }
  }

  snapshot() {
    const now = this.now();
    return [...this.states.values()].map((state) => ({
      id: state.account.id,
      name: state.account.name,
      enabled: state.account.enabled,
      mode: state.account.mode || "flash",
      model: state.account.model,
      priority: state.account.priority,
      active: state.active,
      maxConcurrency: state.account.maxConcurrency,
      submitPerMinute: state.account.submitPerMinute,
      cooldownMsRemaining: Math.max(0, state.cooldownUntil - now),
      successes: state.successes,
      failures: state.failures
    }));
  }

  acquire(excludedIds = new Set(), filters = {}) {
    const now = this.now();
    const candidates = [];
    for (const state of this.states.values()) {
      if (!state.account.enabled) continue;
      if (state.account.tokenRequired && !state.account.apiKey) continue;
      if (filters.mode && state.account.mode !== filters.mode) continue;
      if (excludedIds.has(state.account.id)) continue;
      if (state.cooldownUntil > now) continue;
      if (state.active >= state.account.maxConcurrency) continue;
      this.#resetMinuteWindowIfNeeded(state, now);
      if (state.minuteSubmits >= state.account.submitPerMinute) continue;
      candidates.push(state);
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => {
      if (a.account.priority !== b.account.priority) return a.account.priority - b.account.priority;
      const aLoad = a.active / a.account.maxConcurrency;
      const bLoad = b.active / b.account.maxConcurrency;
      if (aLoad !== bLoad) return aLoad - bLoad;
      return a.lastUsedAt - b.lastUsedAt;
    });

    const state = candidates[0];
    state.active += 1;
    state.minuteSubmits += 1;
    state.lastUsedAt = now;

    let released = false;
    return {
      account: state.account,
      release: (result = "success") => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
        if (result === "success") {
          state.successes += 1;
        } else {
          state.failures += 1;
        }
      }
    };
  }

  cooldown(accountId, ms) {
    const state = this.states.get(accountId);
    if (!state) return;
    state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + ms);
  }

  #resetMinuteWindowIfNeeded(state, now) {
    if (!state.minuteWindowStartedAt || now - state.minuteWindowStartedAt >= 60_000) {
      state.minuteWindowStartedAt = now;
      state.minuteSubmits = 0;
    }
  }
}
