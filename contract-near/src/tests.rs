use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};
const N: u128 = 10u128.pow(24);
fn ctx(who: &str) { let mut c = VMContextBuilder::new(); c.current_account_id("pot.testnet".parse().unwrap()).predecessor_account_id(who.parse().unwrap())
    .storage_usage(10_000).account_balance(NearToken::from_yoctonear(10 * N)); testing_env!(c.build()); }
fn pot() -> Pot { ctx("owner.testnet"); Pot::new("owner.testnet".parse().unwrap(), "agent.testnet".parse().unwrap(), U128(N / 2), 3, U128(5 * N), U128(N / 20)) }
#[test] fn pays_half_near() { let mut p = pot(); ctx("agent.testnet"); p.pay("a.testnet".parse().unwrap(), "r".into()); assert_eq!(p.wins_of("a.testnet".parse().unwrap()), 1); assert_eq!(p.payouts[0].amount.0, N / 2); }
#[test] #[should_panic(expected = "account already paid")] fn repeat() { let mut p = pot(); ctx("agent.testnet"); for _i in 0..4 { p.pay("a.testnet".parse().unwrap(), format!("r{}", p.payouts.len())); } }
#[test] #[should_panic(expected = "unauthorized")] fn stranger() { let mut p = pot(); ctx("x.testnet"); p.pay("a.testnet".parse().unwrap(), format!("r{}", p.payouts.len())); }
#[test] #[should_panic(expected = "daily cap reached")] fn daily() { let mut p = pot(); ctx("agent.testnet");
    for a in 0..11 { p.pay(format!("winner{a}.testnet").parse().unwrap(), format!("r{}", p.payouts.len())); } }
#[test] #[should_panic(expected = "recipient not allowed")] fn self_pay() { let mut p = pot(); ctx("agent.testnet"); p.pay("agent.testnet".parse().unwrap(), format!("r{}", p.payouts.len())); }
#[test] #[should_panic(expected = "owner only")] fn limits_owner_only() { let mut p = pot(); ctx("agent.testnet");
    p.set_limits(Limits { per_win: U128(N), max_wins_per_account: 9, daily_cap: U128(N), reserve: U128(0) }); }

#[test] fn allows_three_wins() { let mut p = pot(); ctx("agent.testnet"); for _i in 0..3 { p.pay("a.testnet".parse().unwrap(), format!("r{}", p.payouts.len())); } assert_eq!(p.wins_of("a.testnet".parse().unwrap()), 3); }

#[test] #[should_panic(expected = "duplicate game_ref")]
fn duplicate_ref() { let mut p = pot(); ctx("agent.testnet"); p.pay("a.testnet".parse().unwrap(), "same".into()); p.pay("b.testnet".parse().unwrap(), "same".into()); }
fn callback(ok: bool, timestamp: u64) {
    let mut p = pot(); ctx("agent.testnet"); p.pay("a.testnet".parse().unwrap(), "cb".into());
    let mut c = VMContextBuilder::new(); c.current_account_id("pot.testnet".parse().unwrap()).predecessor_account_id("pot.testnet".parse().unwrap()).block_timestamp(timestamp);
    testing_env!(c.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }]);
    assert_eq!(p.on_transfer(0), ok); assert!(env::storage_has_key(b"r:cb")); assert_eq!(p.in_flight, 0);
    assert_eq!(p.total_paid, if ok { N/2 } else { 0 });
    assert_eq!(p.today, if ok { N/2 } else { 0 });
    assert_eq!(p.wins_of("a.testnet".parse().unwrap()), if ok { 1 } else { 0 });
}
#[test] fn callback_success() { callback(true, 1); }
#[test] fn callback_failure() { callback(false, 1); }
#[test] fn daily_rollover() { let mut p = pot(); ctx("agent.testnet"); p.pay("a.testnet".parse().unwrap(), "day1".into()); p.day_start = 0;
 let mut c = VMContextBuilder::new(); c.current_account_id("pot.testnet".parse().unwrap()).predecessor_account_id("agent.testnet".parse().unwrap()).block_timestamp(DAY_NS).account_balance(NearToken::from_near(10)); testing_env!(c.build());
 p.pay("b.testnet".parse().unwrap(), "day2".into()); assert_eq!(p.today, N/2); assert!(env::storage_has_key(b"r:day1")); assert!(env::storage_has_key(b"r:day2")); }

#[test] fn old_failure_does_not_refund_new_day() {
 let mut p = pot(); ctx("agent.testnet"); p.pay("a.testnet".parse().unwrap(), "old".into());
 let mut c = VMContextBuilder::new(); c.current_account_id("pot.testnet".parse().unwrap()).predecessor_account_id("agent.testnet".parse().unwrap()).block_timestamp(DAY_NS).account_balance(NearToken::from_near(10)); testing_env!(c.build());
 p.pay("b.testnet".parse().unwrap(), "new".into());
 c.predecessor_account_id("pot.testnet".parse().unwrap());
 testing_env!(c.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
 assert!(!p.on_transfer(0)); assert_eq!(p.today, N/2); assert_eq!(p.in_flight, N/2);
 assert_eq!(p.wins_of("a.testnet".parse().unwrap()), 0);
 assert_eq!(p.wins_of("b.testnet".parse().unwrap()), 1);
}
#[test] fn legacy_lookup_still_works() { let mut p=pot(); ctx("agent.testnet"); p.pay("a.testnet".parse().unwrap(), "legacy".into()); env::storage_remove(b"ref:legacy"); assert!(p.get_payment_by_ref("legacy".into()).is_some()); }

#[test] #[should_panic(expected = "duplicate game_ref")]
fn seeded_legacy_ref_is_rejected() {
 let mut p=pot(); p.mark_refs_used(vec!["legacy".into()]);
 ctx("agent.testnet"); p.pay("a.testnet".parse().unwrap(), "legacy".into());
}
#[test] #[should_panic(expected = "owner only")]
fn seed_owner_only() { let mut p=pot(); ctx("agent.testnet"); p.mark_refs_used(vec!["legacy".into()]); }
