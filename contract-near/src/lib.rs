//! Crucible pot: pays game winners in native NEAR, with hard limits enforced here.
//! Only the owner or the agent (the game server) can call `pay`. The amount is fixed by
//! the contract (`per_win`), never by the caller or the AI.
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};

const DAY_NS: u64 = 86_400_000_000_000;
const CB_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status { Pending, Paid, Failed }

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Payout { pub id: u64, pub to: AccountId, pub amount: U128, pub game_ref: String, pub ts: u64, pub status: Status }

#[near(serializers = [json])]
pub struct Limits { pub per_win: U128, pub max_wins_per_account: u32, pub daily_cap: U128, pub reserve: U128 }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pot {
    owner: AccountId,
    agent: AccountId,
    paused: bool,
    per_win: u128,
    max_wins_per_account: u32,
    daily_cap: u128,
    /// Kept back on top of storage so callbacks and future calls always have gas money.
    reserve: u128,
    day_start: u64,
    today: u128,
    /// Sent but not yet confirmed. Counts against limits until the callback settles it.
    in_flight: u128,
    total_paid: u128,
    wins: LookupMap<AccountId, u32>,
    payouts: Vector<Payout>,
}

#[near]
impl Pot {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, per_win: U128, max_wins_per_account: u32, daily_cap: U128, reserve: U128) -> Self {
        let mut s = Self { owner, agent, paused: false, per_win: 0, max_wins_per_account: 0, daily_cap: 0, reserve: 0,
            day_start: 0, today: 0, in_flight: 0, total_paid: 0, wins: LookupMap::new(b"w".to_vec()), payouts: Vector::new(b"p".to_vec()) };
        s.apply(Limits { per_win, max_wins_per_account, daily_cap, reserve });
        s
    }

    fn only_owner(&self) { require!(env::predecessor_account_id() == self.owner, "owner only"); }
    fn apply(&mut self, l: Limits) {
        require!(l.per_win.0 > 0 && l.per_win.0 <= l.daily_cap.0, "need 0 < per_win <= daily_cap");
        require!(l.max_wins_per_account >= 1, "max_wins_per_account >= 1");
        self.per_win = l.per_win.0; self.max_wins_per_account = l.max_wins_per_account; self.daily_cap = l.daily_cap.0; self.reserve = l.reserve.0;
    }

    // ---------- owner ----------
    pub fn set_limits(&mut self, limits: Limits) {
        self.only_owner(); self.apply(limits);
        env::log_str(&format!("EVENT set_limits per_win={} max_wins={} daily_cap={} reserve={}", self.per_win, self.max_wins_per_account, self.daily_cap, self.reserve));
    }
    pub fn set_agent(&mut self, agent: AccountId) { self.only_owner(); self.agent = agent; }
    pub fn pause(&mut self) { self.only_owner(); self.paused = true; env::log_str("EVENT paused"); }
    pub fn unpause(&mut self) { self.only_owner(); self.paused = false; env::log_str("EVENT unpaused"); }
    /// Owner pulls unused pot back. Cannot touch storage, reserve or in-flight payouts.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.only_owner();
        require!(amount.0 > 0 && amount.0 <= self.available(), "exceeds available");
        env::log_str(&format!("EVENT withdraw {}", amount.0));
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }
    /// Anyone can top up the pot.
    #[payable]
    pub fn fund(&mut self) { env::log_str(&format!("EVENT fund {} from {}", env::attached_deposit().as_yoctonear(), env::predecessor_account_id())); }

    // ---------- payout ----------
    /// Pay one win of `per_win` NEAR to `to`. Every limit is checked and recorded BEFORE the transfer
    /// is scheduled, so a second concurrent call already sees the first one.
    pub fn pay(&mut self, to: AccountId, game_ref: String) -> Promise {
        let caller = env::predecessor_account_id();
        require!(caller == self.agent || caller == self.owner, "unauthorized");
        require!(!self.paused, "paused");
        let me = env::current_account_id();
        require!(to != me && to != self.owner && to != self.agent, "recipient not allowed");
        let amount = self.per_win;
        let now = env::block_timestamp();
        if now >= self.day_start + DAY_NS { self.day_start = now; self.today = 0; }
        require!(self.today + amount <= self.daily_cap, "daily cap reached");
        let n = self.wins.get(&to).copied().unwrap_or(0);
        require!(n < self.max_wins_per_account, "account already paid");
        require!(amount <= self.available(), "pot empty");
        self.today += amount; self.in_flight += amount; self.wins.insert(to.clone(), n + 1);
        let id = self.payouts.len() as u64;
        self.payouts.push(Payout { id, to: to.clone(), amount: U128(amount), game_ref: game_ref.chars().take(64).collect(), ts: now, status: Status::Pending });
        env::log_str(&format!("EVENT pay id={} to={} amount={}", id, to, amount));
        Promise::new(to).transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(me).with_static_gas(CB_GAS).on_transfer(id))
    }

    /// Settles a payout. On failure the NEAR is refunded to this account by the protocol,
    /// so the limits it used are released and the payout is marked Failed.
    #[private]
    pub fn on_transfer(&mut self, id: u64) -> bool {
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        let mut p = self.payouts.get(id as u32).cloned().expect("payout");
        require!(p.status == Status::Pending, "already settled");
        let amt = p.amount.0;
        self.in_flight -= amt;
        if ok { self.total_paid += amt; p.status = Status::Paid; }
        else {
            if p.ts >= self.day_start { self.today = self.today.saturating_sub(amt); }
            let n = self.wins.get(&p.to).copied().unwrap_or(1);
            if n <= 1 { self.wins.remove(&p.to); } else { self.wins.insert(p.to.clone(), n - 1); }
            p.status = Status::Failed;
        }
        env::log_str(&format!("EVENT {} id={}", if ok { "paid" } else { "failed" }, id));
        self.payouts.set(id as u32, p);
        ok
    }

    // ---------- views ----------
    /// Spendable now: balance minus storage stake and reserve. A scheduled transfer is already taken out of
    /// account_balance by the runtime, so in-flight payouts are not subtracted again (in_flight is bookkeeping only).
    pub fn available(&self) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance().as_yoctonear().saturating_sub(storage + self.reserve)
    }
    pub fn get_state(&self) -> near_sdk::serde_json::Value {
        let fresh = env::block_timestamp() >= self.day_start + DAY_NS;
        near_sdk::serde_json::json!({ "version": "pot-1", "owner": self.owner, "agent": self.agent, "paused": self.paused,
            "per_win": self.per_win.to_string(), "max_wins_per_account": self.max_wins_per_account, "daily_cap": self.daily_cap.to_string(),
            "reserve": self.reserve.to_string(), "today": (if fresh { 0 } else { self.today }).to_string(), "day_start": self.day_start.to_string(),
            "in_flight": self.in_flight.to_string(), "total_paid": self.total_paid.to_string(), "available": U128(self.available()),
            "balance": env::account_balance().as_yoctonear().to_string(), "payouts": self.payouts.len() })
    }
    pub fn wins_of(&self, account_id: AccountId) -> u32 { self.wins.get(&account_id).copied().unwrap_or(0) }
    pub fn get_payout(&self, id: u64) -> Option<Payout> { self.payouts.get(id as u32).cloned() }
    pub fn get_payouts(&self, from: u64, limit: u64) -> Vec<Payout> {
        (from..(from.saturating_add(limit.min(50))).min(self.payouts.len() as u64)).filter_map(|i| self.payouts.get(i as u32).cloned()).collect()
    }
}

#[cfg(test)]
mod tests;
