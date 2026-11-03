use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};
const N: u128 = 10u128.pow(24);
fn ctx(who: &str) { let mut c = VMContextBuilder::new(); c.current_account_id("pot.testnet".parse().unwrap()).predecessor_account_id(who.parse().unwrap())
    .storage_usage(10_000).account_balance(NearToken::from_yoctonear(10 * N)); testing_env!(c.build()); }
fn pot() -> Pot { ctx("owner.testnet"); Pot::new("owner.testnet".parse().unwrap(), "agent.testnet".parse().unwrap(), U128(N / 10), 1, U128(3 * N / 10), U128(N / 20)) }
#[test] fn pays_and_blocks_repeat() { let mut p = pot(); ctx("agent.testnet"); p.pay("a.testnet".parse().unwrap(), "r".into()); assert_eq!(p.wins_of("a.testnet".parse().unwrap()), 1); }
#[test] #[should_panic(expected = "account already paid")] fn repeat() { let mut p = pot(); ctx("agent.testnet"); p.pay("a.testnet".parse().unwrap(), "r".into()); p.pay("a.testnet".parse().unwrap(), "r".into()); }
#[test] #[should_panic(expected = "unauthorized")] fn stranger() { let mut p = pot(); ctx("x.testnet"); p.pay("a.testnet".parse().unwrap(), "r".into()); }
#[test] #[should_panic(expected = "daily cap reached")] fn daily() { let mut p = pot(); ctx("agent.testnet");
    for a in ["a", "b", "c", "d"] { p.pay(format!("{a}.testnet").parse().unwrap(), "r".into()); } }
#[test] #[should_panic(expected = "recipient not allowed")] fn self_pay() { let mut p = pot(); ctx("agent.testnet"); p.pay("agent.testnet".parse().unwrap(), "r".into()); }
#[test] #[should_panic(expected = "owner only")] fn limits_owner_only() { let mut p = pot(); ctx("agent.testnet");
    p.set_limits(Limits { per_win: U128(N), max_wins_per_account: 9, daily_cap: U128(N), reserve: U128(0) }); }
