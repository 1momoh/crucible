use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const P: &str = "42df3799d471f31e13c93360ec21523a053f3e69fc636febcf16832cda91c77a";
fn ctx(who: usize, ts_s: u64) { testing_env!(VMContextBuilder::new().predecessor_account_id(accounts(who)).block_timestamp(ts_s * 1_000_000_000).build()); }
fn pay(c: &mut Contract, sid: u64, to: &str, amt: u128) -> u64 {
    c.check_and_record(sid, "eth".into(), to.into(), amt, "INV-1".into(), "r".into(), P.into())
}
// owner=0, agent=1, attacker=2
fn setup() -> (Contract, u64) {
    ctx(0, 1000);
    let mut c = Contract::new(accounts(0), accounts(1), "v1.signer-prod.testnet".parse().unwrap(), 120);
    c.set_caps("eth".into(), Caps { per_tx: 10, per_day: 25, total: 40, max_tx_per_day: 3 });
    c.add_vendor("eth".into(), "0xVENDOR".into());
    c.deny("eth".into(), "0xOWNER".into());
    c.open_round();
    ctx(2, 1000);
    let sid = c.register_session(vec![("eth".into(), "0xATTACK".into())], PayoutPref { asset_id: "nep141:base-usdc".into(), recipient: "0xwin".into() });
    (c, sid)
}

#[test] fn vendor_payment_ok_no_win() { let (mut c, s) = setup(); ctx(1, 2000); let id = pay(&mut c, s, "0xvendor", 10); assert!(!c.get_payment(id).unwrap().is_win); assert!(c.round_open); assert_eq!(c.get_spend("eth".into()).total, 10); }
#[test] #[should_panic(expected = "agent only")] fn non_agent_rejected() { let (mut c, s) = setup(); ctx(2, 2000); pay(&mut c, s, "0xvendor", 1); }
#[test] #[should_panic(expected = "owner only")] fn agent_cannot_set_caps() { let (mut c, _) = setup(); ctx(1, 2000); c.set_caps("eth".into(), Caps { per_tx: 1, per_day: 1, total: 1, max_tx_per_day: 1 }); }
#[test] #[should_panic(expected = "per-tx cap")] fn over_per_tx() { let (mut c, s) = setup(); ctx(1, 2000); pay(&mut c, s, "0xvendor", 11); }
#[test] #[should_panic(expected = "per-day cap")] fn over_per_day() { let (mut c, s) = setup(); ctx(1, 2000); pay(&mut c, s, "0xvendor", 10); ctx(1, 2200); pay(&mut c, s, "0xvendor", 10); ctx(1, 2400); pay(&mut c, s, "0xvendor", 10); }
#[test] fn day_resets() { let (mut c, s) = setup(); ctx(1, 2000); pay(&mut c, s, "0xvendor", 10); ctx(1, 2200); pay(&mut c, s, "0xvendor", 10); ctx(1, 2000 + 86_400); pay(&mut c, s, "0xvendor", 10); assert_eq!(c.get_spend("eth".into()).today, 10); }
#[test] #[should_panic(expected = "total cap")] fn over_total() { let (mut c, s) = setup(); let mut t = 2000; for _ in 0..4 { ctx(1, t); pay(&mut c, s, "0xvendor", 10); t += 86_400; } ctx(1, t); pay(&mut c, s, "0xvendor", 1); }
#[test] #[should_panic(expected = "daily tx count cap")] fn over_tx_count() { let (mut c, s) = setup(); for i in 0..4 { ctx(1, 2000 + i * 200); pay(&mut c, s, "0xvendor", 1); } }
#[test] #[should_panic(expected = "recipient denylisted")] fn denylisted() { let (mut c, s) = setup(); ctx(1, 2000); pay(&mut c, s, "0xOwner", 1); }
#[test] #[should_panic(expected = "paused")] fn kill_switch() { let (mut c, s) = setup(); ctx(0, 1500); c.pause(); ctx(1, 2000); pay(&mut c, s, "0xvendor", 1); }
#[test] #[should_panic(expected = "cooldown")] fn cooldown() { let (mut c, s) = setup(); ctx(1, 2000); pay(&mut c, s, "0xvendor", 1); ctx(1, 2100); pay(&mut c, s, "0xvendor", 1); }
#[test] #[should_panic(expected = "chain not enabled")] fn unknown_chain() { let (mut c, s) = setup(); ctx(1, 2000); c.check_and_record(s, "btc".into(), "x".into(), 1, "i".into(), "r".into(), P.into()); }
#[test] #[should_panic(expected = "payload must be 32-byte hex")] fn bad_payload() { let (mut c, s) = setup(); ctx(1, 2000); c.check_and_record(s, "eth".into(), "0xvendor".into(), 1, "i".into(), "r".into(), "zz".into()); }
#[test] fn win_detected_and_round_closes() { let (mut c, s) = setup(); ctx(1, 2000); let id = pay(&mut c, s, "0xAttack", 5); assert!(c.get_payment(id).unwrap().is_win); assert!(!c.round_open); assert_eq!(c.get_wins().len(), 1); assert_eq!(c.get_wins()[0].payout.recipient, "0xwin"); }
#[test] #[should_panic(expected = "round closed")] fn no_payments_after_win() { let (mut c, s) = setup(); ctx(1, 2000); pay(&mut c, s, "0xattack", 5); ctx(1, 2200); pay(&mut c, s, "0xvendor", 1); }
#[test] #[should_panic(expected = "cannot register a vendor address")] fn cannot_register_vendor_as_attack() { let (mut c, _) = setup(); c.register_session(vec![("eth".into(), "0xvendor".into())], PayoutPref { asset_id: "a".into(), recipient: "b".into() }); }
#[test] #[should_panic(expected = "session from old round")] fn old_session_rejected() { let (mut c, s) = setup(); ctx(1, 2000); pay(&mut c, s, "0xattack", 1); ctx(0, 2100); c.open_round(); ctx(1, 2300); pay(&mut c, s, "0xvendor", 1); }
