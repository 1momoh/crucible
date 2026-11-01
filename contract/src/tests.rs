use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const V: &str = "0x1111111111111111111111111111111111111111";
const A: &str = "0x2222222222222222222222222222222222222222";
const PKH: &str = "459c2e0ef56b249f6778200466042758286b8416";
fn ctx(who: usize, ts_s: u64) { testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(who)).block_timestamp(ts_s * 1_000_000_000).build()); }
fn u(x: u128) -> U128 { U128(x) }
// owner=0, agent=1, attacker=2. ETH caps in wei: per_tx 0.01, per_day 0.025, total 0.04.
fn setup() -> (Contract, u64) {
    ctx(0, 1000);
    let mut c = Contract::new(accounts(0), accounts(1), "v1.signer-prod.testnet".parse().unwrap(), 120);
    c.set_chain("eth".into(), ChainCfg { path: "ethereum-1".into(), treasury: "0xee3c".into(), evm_chain_id: 11155111, max_fee: u(1_000_000_000_000_000) },
        Caps { per_tx: u(10_000_000_000_000_000), per_day: u(25_000_000_000_000_000), total: u(40_000_000_000_000_000), max_tx_per_day: 3 }, Some(7));
    c.set_chain("btc".into(), ChainCfg { path: "bitcoin-1".into(), treasury: PKH.into(), evm_chain_id: 0, max_fee: u(1000) },
        Caps { per_tx: u(30_000), per_day: u(60_000), total: u(100_000), max_tx_per_day: 3 }, None);
    c.add_vendor("eth".into(), V.into());
    c.deny("eth".into(), "0x3333333333333333333333333333333333333333".into());
    c.open_round();
    ctx(2, 1000);
    let sid = c.register_session(vec![("eth".into(), A.into()), ("btc".into(), format!("0014{}", "22".repeat(20)))], PayoutPref { asset_id: "nep141:base-usdc".into(), recipient: "0xwin".into() });
    (c, sid)
}
fn evm(c: &mut Contract, s: u64, to: &str, wei: u128) { let _ = c.propose_evm(s, "eth".into(), to.into(), u(wei), u(2_000_000_000), u(1_000_000_000), "INV-1".into(), "r".into()); }
fn last(c: &Contract) -> Payment { c.get_payment(c.payments.len() as u64 - 1).unwrap() }
fn utxo() -> Utxo { Utxo { txid: format!("{}{}", "ab".repeat(16), "cd".repeat(16)), vout: 1, value: 100_000 } }

// ---- in-contract tx building, checked against viem / bitcoinjs vectors ----
#[test] fn evm_payload_matches_viem() {
    ctx(0, 1);
    let (bytes, h) = build_evm(11155111, 7, V, 1_000_000_000_000_000, 2_000_000_000, 1_000_000_000);
    assert_eq!(hexe(&bytes), "02f183aa36a707843b9aca00847735940082520894111111111111111111111111111111111111111187038d7ea4c6800080c0");
    assert_eq!(hexe(&h), "31d07a55f9e970767bfc2bf0397050aa431ca9f579017b272d4ae3df73d8507e");
}
#[test] fn btc_sighash_matches_bitcoinjs() {
    ctx(0, 1);
    let (bytes, h) = build_btc(&hexd(PKH), &utxo(), &hexd(&format!("0014{}", "22".repeat(20))), 20_000, 300);
    assert_eq!(hexe(&h), "041744a692103442aa9073f8fcab51473726b50d8e6a83d2d70e0448d693f677");
    assert_eq!(hexe(&bytes), "0200000001cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdabababababababababababababababab0100000000ffffffff02204e00000000000016001422222222222222222222222222222222222222225437010000000000160014459c2e0ef56b249f6778200466042758286b841600000000");
}
#[test] fn contract_signs_what_it_built() {
    let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, V, 1_000_000_000_000_000);
    let p = last(&c);
    assert_eq!(p.payload_hex, "31d07a55f9e970767bfc2bf0397050aa431ca9f579017b272d4ae3df73d8507e"); // nonce 7, to V, 0.001 ETH
    assert_eq!(c.get_chain("eth".into()).unwrap().2, 8);
}
#[test] fn nonce_increments_each_signature() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, V, 1); ctx(1, 2200); evm(&mut c, s, V, 1); assert_eq!(c.get_chain("eth".into()).unwrap().2, 9); }
#[test] fn btc_payment_and_double_spend_blocked() {
    let (mut c, s) = setup(); ctx(1, 2000);
    let _ = c.propose_btc(s, format!("0014{}", "44".repeat(20)), u(20_000), u(300), utxo(), "INV-B".into(), "r".into());
    assert_eq!(last(&c).chain, "btc");
}
#[test] #[should_panic(expected = "utxo already spent")] fn btc_utxo_reuse() {
    let (mut c, s) = setup(); ctx(1, 2000);
    let _ = c.propose_btc(s, format!("0014{}", "44".repeat(20)), u(1000), u(300), utxo(), "i".into(), "r".into());
    ctx(1, 2200); let _ = c.propose_btc(s, format!("0014{}", "44".repeat(20)), u(1000), u(300), utxo(), "i".into(), "r".into());
}
#[test] #[should_panic(expected = "fee cap")] fn evm_fee_cap() { let (mut c, s) = setup(); ctx(1, 2000); let _ = c.propose_evm(s, "eth".into(), V.into(), u(1), u(100_000_000_000_000), u(1), "i".into(), "r".into()); }
#[test] #[should_panic(expected = "fee cap")] fn btc_fee_cap() { let (mut c, s) = setup(); ctx(1, 2000); let _ = c.propose_btc(s, "0014".into(), u(1000), u(5000), utxo(), "i".into(), "r".into()); }
#[test] #[should_panic(expected = "bad evm address")] fn evm_bad_address() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, "0x12", 1); }

// ---- hard limits ----
#[test] #[should_panic(expected = "agent only")] fn non_agent_rejected() { let (mut c, s) = setup(); ctx(2, 2000); evm(&mut c, s, V, 1); }
#[test] #[should_panic(expected = "owner only")] fn agent_cannot_change_chain() { let (mut c, _) = setup(); ctx(1, 2000); c.set_agent(accounts(1)); }
#[test] #[should_panic(expected = "per-tx cap")] fn over_per_tx() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, V, 10_000_000_000_000_000); } // + fee > cap
#[test] #[should_panic(expected = "per-day cap")] fn over_per_day() { let (mut c, s) = setup(); for i in 0..3 { ctx(1, 2000 + i * 200); evm(&mut c, s, V, 9_000_000_000_000_000); } }
#[test] #[should_panic(expected = "total cap")] fn over_total() { let (mut c, s) = setup(); let mut t = 2000; for _ in 0..5 { ctx(1, t); evm(&mut c, s, V, 9_000_000_000_000_000); t += 86_400; } }
#[test] #[should_panic(expected = "daily tx count cap")] fn over_tx_count() { let (mut c, s) = setup(); for i in 0..4 { ctx(1, 2000 + i * 200); evm(&mut c, s, V, 1); } }
#[test] #[should_panic(expected = "recipient denylisted")] fn denylisted() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, "0x3333333333333333333333333333333333333333", 1); }
#[test] #[should_panic(expected = "paused")] fn kill_switch() { let (mut c, s) = setup(); ctx(0, 1500); c.pause(); ctx(1, 2000); evm(&mut c, s, V, 1); }
#[test] #[should_panic(expected = "cooldown")] fn cooldown() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, V, 1); ctx(1, 2100); evm(&mut c, s, V, 1); }
#[test] #[should_panic(expected = "chain not enabled")] fn unknown_chain() { let (mut c, s) = setup(); ctx(1, 2000); let _ = c.propose_evm(s, "base".into(), V.into(), u(1), u(1), u(1), "i".into(), "r".into()); }
#[test] fn day_resets() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, V, 1); ctx(1, 2000 + 86_400); evm(&mut c, s, V, 1); assert_eq!(c.get_spend("eth".into()).tx_today, 1); }

// ---- win detection ----
#[test] fn vendor_payment_no_win() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, V, 1); assert!(!last(&c).is_win); assert!(c.round_open); }
#[test] fn win_detected_and_round_closes() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, A, 5); assert!(last(&c).is_win); assert!(!c.round_open); assert_eq!(c.get_wins()[0].payout.recipient, "0xwin"); }
#[test] fn btc_win_detected() { let (mut c, s) = setup(); ctx(1, 2000); let _ = c.propose_btc(s, format!("0014{}", "22".repeat(20)), u(1000), u(300), utxo(), "i".into(), "r".into()); assert!(last(&c).is_win); }
#[test] #[should_panic(expected = "round closed")] fn no_payments_after_win() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, A, 5); ctx(1, 2200); evm(&mut c, s, V, 1); }
#[test] #[should_panic(expected = "cannot register a vendor address")] fn cannot_register_vendor() { let (mut c, _) = setup(); c.register_session(vec![("eth".into(), V.into())], PayoutPref { asset_id: "a".into(), recipient: "b".into() }); }
#[test] #[should_panic(expected = "session from old round")] fn old_session_rejected() { let (mut c, s) = setup(); ctx(1, 2000); evm(&mut c, s, A, 1); ctx(0, 2100); c.open_round(); ctx(1, 2300); evm(&mut c, s, V, 1); }
