# Solana deactivate delinquent

Stake of Solana validators inactivate for multiple epochs can be de-activated in a permissionless way. This repo is a simple automation of this process.

## Analytics
The following query can be run on flipside to check how the de-activations done by this code are doing:
```sql
select
  tx_id as "Transaction",
  block_timestamp as "Block timestamp",
  post_balances[account.index] / 1e9 as "Unstaked balance",
  instruction.value:parsed.info.voteAccount as "Delinquent validator",
  account.value:pubkey as "Stake account"
from
  solana.core.fact_transactions txs,
  lateral flatten(input => txs.instructions) as instruction,
  lateral flatten(input => txs.account_keys) as account
where
  date_trunc('day', block_timestamp) between '2024-01-01' and '2024-01-31'
  and array_contains('ByeByeS4EhEhAPmqE2nULzwzx9yK1Ee47We3TCQ5Bwys'::variant, signers)
  and succeeded = TRUE
  and account.value:pubkey = instruction.value:parsed.info.stakeAccount
order by
  date_trunc('day', block_timestamp) desc
limit 10000
```
