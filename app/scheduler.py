from __future__ import annotations

import time
from dataclasses import dataclass
from threading import Lock

from .config import Account, Mode


@dataclass
class AccountState:
    account: Account
    active: int = 0
    successes: int = 0
    failures: int = 0
    last_used_at: float = 0
    cooldown_until: float = 0
    minute_started_at: float = 0
    minute_submits: int = 0


class AccountScheduler:
    def __init__(self, accounts: list[Account]):
        self._lock = Lock()
        self._states: dict[str, AccountState] = {}
        self.replace(accounts)

    def replace(self, accounts: list[Account]) -> None:
        with self._lock:
            old = self._states
            self._states = {}
            for account in accounts:
                prev = old.get(account.id)
                self._states[account.id] = AccountState(
                    account=account,
                    active=prev.active if prev else 0,
                    successes=prev.successes if prev else 0,
                    failures=prev.failures if prev else 0,
                    last_used_at=prev.last_used_at if prev else 0,
                    cooldown_until=prev.cooldown_until if prev else 0,
                    minute_started_at=prev.minute_started_at if prev else 0,
                    minute_submits=prev.minute_submits if prev else 0,
                )

    def snapshot(self) -> list[dict]:
        now = time.time()
        with self._lock:
            return [
                {
                    "id": state.account.id,
                    "name": state.account.name,
                    "mode": state.account.mode,
                    "enabled": state.account.enabled,
                    "priority": state.account.priority,
                    "active": state.active,
                    "maxConcurrency": state.account.max_concurrency,
                    "submitPerMinute": state.account.submit_per_minute,
                    "minuteSubmits": state.minute_submits if now - state.minute_started_at < 60 else 0,
                    "minuteWindowMsRemaining": max(0, int((state.minute_started_at + 60 - now) * 1000)) if state.minute_started_at else 0,
                    "cooldownMsRemaining": max(0, int((state.cooldown_until - now) * 1000)),
                    "lastUsedAtMs": int(state.last_used_at * 1000) if state.last_used_at else 0,
                    "successes": state.successes,
                    "failures": state.failures,
                    "model": state.account.model,
                    "tokenRequired": state.account.mode == "precision",
                }
                for state in self._states.values()
            ]

    def acquire(self, mode: Mode, exclude: set[str] | None = None):
        now = time.time()
        excluded = exclude or set()
        with self._lock:
            candidates: list[AccountState] = []
            for state in self._states.values():
                account = state.account
                if account.id in excluded:
                    continue
                if not account.enabled or account.mode != mode:
                    continue
                if account.mode == "precision" and not account.token:
                    continue
                if state.cooldown_until > now:
                    continue
                if state.active >= account.max_concurrency:
                    continue
                if now - state.minute_started_at >= 60:
                    state.minute_started_at = now
                    state.minute_submits = 0
                if state.minute_submits >= account.submit_per_minute:
                    continue
                candidates.append(state)
            if not candidates:
                return None
            candidates.sort(key=lambda state: (
                state.account.priority,
                state.active / state.account.max_concurrency,
                state.last_used_at,
            ))
            selected = candidates[0]
            selected.active += 1
            selected.minute_submits += 1
            selected.last_used_at = now
            return AccountLease(self, selected.account.id)

    def release(self, account_id: str, success: bool) -> None:
        with self._lock:
            state = self._states.get(account_id)
            if not state:
                return
            state.active = max(0, state.active - 1)
            if success:
                state.successes += 1
            else:
                state.failures += 1
                state.cooldown_until = max(state.cooldown_until, time.time() + state.account.cooldown_seconds)

    def account(self, account_id: str) -> Account | None:
        with self._lock:
            state = self._states.get(account_id)
            return state.account if state else None


class AccountLease:
    def __init__(self, scheduler: AccountScheduler, account_id: str):
        self.scheduler = scheduler
        self.account_id = account_id
        self.released = False

    def account(self) -> Account:
        account = self.scheduler.account(self.account_id)
        if account is None:
            raise RuntimeError("selected account disappeared")
        return account

    def release(self, success: bool) -> None:
        if self.released:
            return
        self.released = True
        self.scheduler.release(self.account_id, success)
