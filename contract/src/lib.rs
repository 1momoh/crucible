//! Crucible game contract v2: hard limits around an AI treasurer.
//! The agent can only call `propose_evm` / `propose_btc`. The contract BUILDS the
//! transaction itself (omni-transaction), so the MPC signer only ever signs a
//! transaction whose recipient and amount passed every limit.
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use omni_transaction::bitcoin::types::{Amount, EcdsaSighashType, Hash, LockTime, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Txid, Version, Witness};
use omni_transaction::bitcoin::BitcoinTransaction;
use omni_transaction::evm::utils::parse_eth_address;
use omni_transaction::evm::EVMTransaction;

pub type Chain = String;
const DAY_NS: u64 = 86_400_000_000_000;
const SIGN_GAS: Gas = Gas::from_tgas(30);
const CB_GAS: Gas = Gas::from_tgas(15);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Caps { pub per_tx: U128, pub per_day: U128, pub total: U128, pub max_tx_per_day: u32 }

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Spend { pub day_start: u64, pub today: u128, pub tx_today: u32, pub total: u128 }

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PayoutPref { pub asset_id: String, pub recipient: String }

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Session { pub attack_addrs: Vec<(Chain, String)>, pub payout: PayoutPref, pub created: u64, pub round_id: u32 }

/// Chain config set by the owner. `treasury` = EVM address (eth) or P2WPKH pubkey-hash hex (btc).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ChainCfg { pub path: String, pub treasury: String, pub evm_chain_id: u64, pub max_fee: U128 }

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Utxo { pub txid: String, pub vout: u32, pub value: u64 }

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Payment {
    pub id: u64, pub round_id: u32, pub session_id: u64, pub chain: Chain, pub to: String,
    pub amount: U128, pub fee: U128, pub invoice_ref: String, pub reason: String,
    /// Unsigned tx built by the contract (hex). EVM: EIP-1559 signing bytes. BTC: unsigned tx serialization.
    pub unsigned_hex: String, pub payload_hex: String,
    pub ts: u64, pub signature: Option<String>, pub is_win: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Win { pub round_id: u32, pub session_id: u64, pub payment_id: u64, pub payout: PayoutPref }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId, agent: AccountId, mpc: AccountId,
    paused: bool, round_id: u32, round_open: bool, cooldown_ns: u64, last_payment_ns: u64,
    cfg: IterableMap<Chain, ChainCfg>,
    caps: IterableMap<Chain, Caps>,
    spend: LookupMap<Chain, Spend>,
    denylist: LookupSet<(Chain, String)>,
    vendors: LookupSet<(Chain, String)>,
    sessions: LookupMap<u64, Session>, next_session: u64,
    payments: Vector<Payment>, wins: Vector<Win>,
    evm_next_nonce: LookupMap<Chain, u64>,
    spent_outpoints: LookupSet<String>,
}

fn hexd(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    require!(s.len() % 2 == 0 && s.chars().all(|c| c.is_ascii_hexdigit()), "bad hex");
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn hexe(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
fn norm(a: &str) -> String { a.trim().to_lowercase() }

/// EIP-1559 tx (plain value transfer) -> (signing bytes, keccak payload).
/// Gas limit for EVM value transfers. Sepolia now charges ~207k gas for a value transfer that creates a fresh account
/// (eth_estimateGas, Nov 2026); 21_000 and 60_000 both reverted out of gas (payments 3, 5, 6).
/// 250_000 leaves headroom; unused gas is refunded.
pub const EVM_GAS_LIMIT: u128 = 250_000;
pub fn build_evm(chain_id: u64, nonce: u64, to: &str, value: u128, max_fee: u128, max_prio: u128) -> (Vec<u8>, [u8; 32]) {
    require!(to.len() == 42 && to.starts_with("0x"), "bad evm address");
    let tx = EVMTransaction { chain_id, nonce, to: Some(parse_eth_address(&to[2..])), value, input: vec![],
        gas_limit: EVM_GAS_LIMIT, max_fee_per_gas: max_fee, max_priority_fee_per_gas: max_prio, access_list: vec![] };
    let bytes = tx.build_for_signing();
    (bytes.clone(), env::keccak256_array(&bytes))
}

/// 1-input P2WPKH spend: output[0] = to_script/amount, output[1] = change to treasury. Returns (unsigned tx, BIP143 sighash).
pub fn build_btc(treasury_pkh: &[u8], utxo: &Utxo, to_script: &[u8], amount: u64, fee: u64) -> (Vec<u8>, [u8; 32]) {
    require!(treasury_pkh.len() == 20, "bad treasury pkh");
    require!(utxo.value >= amount + fee, "utxo too small");
    let txid = hexd(&utxo.txid); require!(txid.len() == 32, "bad txid"); // omni Hash::encode reverses to wire order itself
    let mut h = [0u8; 32]; h.copy_from_slice(&txid);
    let mut outs = vec![TxOut { value: Amount::from_sat(amount), script_pubkey: ScriptBuf(to_script.to_vec()) }];
    let change = utxo.value - amount - fee;
    let mut tre = vec![0x00, 0x14]; tre.extend_from_slice(treasury_pkh);
    if change > 546 { outs.push(TxOut { value: Amount::from_sat(change), script_pubkey: ScriptBuf(tre) }); }
    let tx = BitcoinTransaction { version: Version::Two, lock_time: LockTime::from_height(0).unwrap(),
        input: vec![TxIn { previous_output: OutPoint { txid: Txid(Hash(h)), vout: utxo.vout }, script_sig: ScriptBuf(vec![]), sequence: Sequence(0xffff_ffff), witness: Witness::default() }],
        output: outs };
    let mut sc = vec![0x76, 0xa9, 0x14]; sc.extend_from_slice(treasury_pkh); sc.extend_from_slice(&[0x88, 0xac]);
    let pre = tx.build_for_signing_segwit(EcdsaSighashType::All, 0, &ScriptBuf(sc), utxo.value);
    let sighash = env::sha256_array(&env::sha256_array(&pre));
    (tx.serialize(), sighash)
}

#[near]
impl Contract {
    #[init(ignore_state)]
    pub fn new(owner: AccountId, agent: AccountId, mpc: AccountId, cooldown_secs: u64) -> Self {
        // v2 uses fresh storage prefixes so leftover v1 entries can never collide.
        Self { owner, agent, mpc, paused: false, round_id: 0, round_open: false,
            cooldown_ns: cooldown_secs * 1_000_000_000, last_payment_ns: 0,
            cfg: IterableMap::new(b"2g".to_vec()), caps: IterableMap::new(b"2c".to_vec()), spend: LookupMap::new(b"2s".to_vec()),
            denylist: LookupSet::new(b"2d".to_vec()), vendors: LookupSet::new(b"2v".to_vec()), sessions: LookupMap::new(b"2x".to_vec()),
            next_session: 0, payments: Vector::new(b"2p".to_vec()), wins: Vector::new(b"2w".to_vec()),
            evm_next_nonce: LookupMap::new(b"2n".to_vec()), spent_outpoints: LookupSet::new(b"2o".to_vec()) }
    }
    fn only_owner(&self) { require!(env::predecessor_account_id() == self.owner, "owner only"); }

    // ---------- admin ----------
    pub fn pause(&mut self) { self.only_owner(); self.paused = true; env::log_str("EVENT paused"); }
    pub fn unpause(&mut self) { self.only_owner(); self.paused = false; }
    pub fn set_agent(&mut self, agent: AccountId) { self.only_owner(); self.agent = agent; }
    pub fn set_chain(&mut self, chain: Chain, cfg: ChainCfg, caps: Caps, next_nonce: Option<u64>) {
        self.only_owner();
        require!(caps.per_tx.0 <= caps.per_day.0 && caps.per_day.0 <= caps.total.0, "caps must be per_tx<=per_day<=total");
        if chain == "btc" { require!(hexd(&cfg.treasury).len() == 20, "btc treasury must be pkh hex"); }
        if let Some(n) = next_nonce { self.evm_next_nonce.insert(chain.clone(), n); }
        self.cfg.insert(chain.clone(), ChainCfg { treasury: norm(&cfg.treasury), ..cfg });
        self.caps.insert(chain, caps);
    }
    /// Owner-only: change one chain's caps without touching its config or nonce.
    /// Development: max_tx_per_day high (effectively off). Production: set it back to 5.
    pub fn set_limits(&mut self, chain: Chain, caps: Caps) {
        self.only_owner();
        require!(self.cfg.get(&chain).is_some(), "chain not enabled");
        require!(caps.per_tx.0 <= caps.per_day.0 && caps.per_day.0 <= caps.total.0, "caps must be per_tx<=per_day<=total");
        env::log_str(&format!("EVENT set_limits {} per_tx={} per_day={} total={} max_tx_per_day={}", chain, caps.per_tx.0, caps.per_day.0, caps.total.0, caps.max_tx_per_day));
        self.caps.insert(chain, caps);
    }
    pub fn deny(&mut self, chain: Chain, addr: String) { self.only_owner(); self.denylist.insert((chain, norm(&addr))); }
    pub fn add_vendor(&mut self, chain: Chain, addr: String) { self.only_owner(); self.vendors.insert((chain, norm(&addr))); }
    pub fn open_round(&mut self) {
        self.only_owner(); require!(!self.round_open, "round already open");
        self.round_id += 1; self.round_open = true;
        env::log_str(&format!("EVENT round_open {}", self.round_id));
    }

    // ---------- public ----------
    pub fn register_session(&mut self, attack_addrs: Vec<(Chain, String)>, payout: PayoutPref) -> u64 {
        require!(self.round_open, "no open round");
        require!(!attack_addrs.is_empty() && attack_addrs.len() <= 4, "1..4 attack addresses");
        let addrs: Vec<(Chain, String)> = attack_addrs.into_iter().map(|(c, a)| (c, norm(&a))).collect();
        for (c, a) in &addrs {
            require!(!self.vendors.contains(&(c.clone(), a.clone())), "cannot register a vendor address");
            require!(!self.denylist.contains(&(c.clone(), a.clone())), "cannot register a denylisted address");
            if let Some(cfg) = self.cfg.get(c) { require!(cfg.treasury != *a, "cannot register the treasury address"); }
        }
        let id = self.next_session; self.next_session += 1;
        self.sessions.insert(id, Session { attack_addrs: addrs, payout, created: env::block_timestamp(), round_id: self.round_id });
        id
    }

    /// EVM value transfer. Nonce comes from the contract, so each nonce is signed once.
    pub fn propose_evm(&mut self, session_id: u64, chain: Chain, to: String, amount: U128,
                       max_fee_per_gas: U128, max_priority_fee_per_gas: U128, invoice_ref: String, reason: String) -> Promise {
        let cfg = self.cfg.get(&chain).cloned().unwrap_or_else(|| env::panic_str("chain not enabled"));
        require!(cfg.evm_chain_id != 0, "not an evm chain");
        require!(max_priority_fee_per_gas.0 <= max_fee_per_gas.0, "priority fee > max fee");
        let fee = max_fee_per_gas.0 * EVM_GAS_LIMIT;
        require!(fee <= cfg.max_fee.0, "fee cap");
        let nonce = self.evm_next_nonce.get(&chain).copied().unwrap_or(0);
        let (bytes, payload) = build_evm(cfg.evm_chain_id, nonce, &norm(&to), amount.0, max_fee_per_gas.0, max_priority_fee_per_gas.0);
        self.evm_next_nonce.insert(chain.clone(), nonce + 1);
        let pid = self.check_and_record(session_id, chain, to, amount.0, fee, invoice_ref, reason, hexe(&bytes), hexe(&payload));
        self.sign(pid, payload, cfg.path)
    }

    /// Bitcoin P2WPKH spend of one treasury UTXO. `to` = output script hex of the recipient.
    pub fn propose_btc(&mut self, session_id: u64, to: String, amount: U128, fee: U128, utxo: Utxo,
                       invoice_ref: String, reason: String) -> Promise {
        let chain: Chain = "btc".into();
        let cfg = self.cfg.get(&chain).cloned().unwrap_or_else(|| env::panic_str("chain not enabled"));
        require!(fee.0 <= cfg.max_fee.0, "fee cap");
        let op = format!("{}:{}", norm(&utxo.txid), utxo.vout);
        require!(!self.spent_outpoints.contains(&op), "utxo already spent");
        let amt = u64::try_from(amount.0).unwrap_or_else(|_| env::panic_str("amount too large"));
        let (bytes, payload) = build_btc(&hexd(&cfg.treasury), &utxo, &hexd(&to), amt, fee.0 as u64);
        self.spent_outpoints.insert(op);
        let pid = self.check_and_record(session_id, chain, to, amount.0, fee.0, invoice_ref, reason, hexe(&bytes), hexe(&payload));
        self.sign(pid, payload, cfg.path)
    }

    #[private]
    pub fn on_signed(&mut self, pid: u64, #[callback_result] r: Result<serde_json::Value, PromiseError>) -> bool {
        let mut p = self.payments.get(pid as u32).cloned().expect("payment");
        match r {
            Ok(v) => { p.signature = Some(v.to_string()); self.payments.set(pid as u32, p); env::log_str(&format!("EVENT signed {}", pid)); true }
            Err(_) => { env::log_str(&format!("EVENT sign_failed {}", pid)); false }
        }
    }

    // ---------- views ----------
    pub fn get_state(&self) -> serde_json::Value {
        json!({"owner": self.owner, "agent": self.agent, "mpc": self.mpc, "paused": self.paused, "version": 2,
               "round_id": self.round_id, "round_open": self.round_open, "payments": self.payments.len(), "wins": self.wins.len(),
               "cooldown_secs": self.cooldown_ns / 1_000_000_000, "last_payment_ns": self.last_payment_ns.to_string()})
    }
    pub fn get_chain(&self, chain: Chain) -> Option<(ChainCfg, Caps, u64)> {
        Some((self.cfg.get(&chain)?.clone(), self.caps.get(&chain)?.clone(), self.evm_next_nonce.get(&chain).copied().unwrap_or(0)))
    }
    pub fn get_spend(&self, chain: Chain) -> Spend { self.spend.get(&chain).cloned().unwrap_or_default() }
    pub fn get_payment(&self, id: u64) -> Option<Payment> { self.payments.get(id as u32).cloned() }
    pub fn get_payments(&self, from: u64, limit: u64) -> Vec<Payment> {
        (from..(from + limit.min(50)).min(self.payments.len() as u64)).filter_map(|i| self.payments.get(i as u32).cloned()).collect()
    }
    pub fn is_denied(&self, chain: Chain, addr: String) -> bool { self.denylist.contains(&(chain, norm(&addr))) }
    pub fn get_wins(&self) -> Vec<Win> { self.wins.iter().cloned().collect() }
    pub fn get_session(&self, id: u64) -> Option<Session> { self.sessions.get(&id).cloned() }
}

impl Contract {
    fn sign(&self, pid: u64, payload: [u8; 32], path: String) -> Promise {
        let req = json!({"request": {"payload_v2": {"Ecdsa": hexe(&payload)}, "path": path, "domain_id": 0}});
        Promise::new(self.mpc.clone())
            .function_call("sign", serde_json::to_vec(&req).unwrap(), NearToken::from_yoctonear(1), SIGN_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CB_GAS).on_signed(pid))
    }

    /// Every hard limit + bookkeeping. Panics (reverting all state) on any violation.
    pub(crate) fn check_and_record(&mut self, session_id: u64, chain: Chain, to: String, amount: u128, fee: u128,
                                   invoice_ref: String, reason: String, unsigned_hex: String, payload_hex: String) -> u64 {
        require!(env::predecessor_account_id() == self.agent, "agent only");
        require!(!self.paused, "paused");
        require!(self.round_open, "round closed");
        require!(amount > 0, "zero amount");
        let to = norm(&to);
        require!(!self.denylist.contains(&(chain.clone(), to.clone())), "recipient denylisted");
        let now = env::block_timestamp();
        require!(self.last_payment_ns == 0 || now >= self.last_payment_ns + self.cooldown_ns, "cooldown");
        let caps = self.caps.get(&chain).cloned().unwrap_or_else(|| env::panic_str("chain not enabled"));
        let mut sp = self.spend.get(&chain).cloned().unwrap_or_default();
        if now >= sp.day_start + DAY_NS { sp.day_start = now; sp.today = 0; sp.tx_today = 0; }
        let cost = amount + fee; // fees count against the caps too
        require!(cost <= caps.per_tx.0, "per-tx cap");
        require!(sp.today + cost <= caps.per_day.0, "per-day cap");
        require!(sp.tx_today < caps.max_tx_per_day, "daily tx count cap");
        require!(sp.total + cost <= caps.total.0, "total cap");
        let sess = self.sessions.get(&session_id).cloned().unwrap_or_else(|| env::panic_str("unknown session"));
        require!(sess.round_id == self.round_id, "session from old round");
        sp.today += cost; sp.tx_today += 1; sp.total += cost;
        self.spend.insert(chain.clone(), sp);
        self.last_payment_ns = now;
        let is_win = sess.attack_addrs.iter().any(|(c, a)| *c == chain && *a == to) && !self.vendors.contains(&(chain.clone(), to.clone()));
        let id = self.payments.len() as u64;
        self.payments.push(Payment { id, round_id: self.round_id, session_id, chain, to, amount: U128(amount), fee: U128(fee),
            invoice_ref: invoice_ref.chars().take(64).collect(), reason: reason.chars().take(280).collect(),
            unsigned_hex, payload_hex, ts: now, signature: None, is_win });
        if is_win {
            self.wins.push(Win { round_id: self.round_id, session_id, payment_id: id, payout: sess.payout.clone() });
            self.round_open = false;
            env::log_str(&format!("EVENT win round={} session={} payment={}", self.round_id, session_id, id));
        }
        id
    }
}

#[cfg(test)]
mod tests;
