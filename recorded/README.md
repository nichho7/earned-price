# Recorded live run (RECORDED replay)

The first live testnet run of the CLI path, 2026-11-12 13:24-13:25 UTC, made by
`scripts/live-run.sh --go` on main `741d0a4` (contract `earned-price.testnet`, seller
`seller.earned-price.testnet`, buyer `earned-price-buyer-09552fb0.testnet`).

When the seller can't review live, `earned hire` (and the site) replays this run, labelled
**RECORDED**. A replay never submits anything on-chain and never writes a receipt for your job.

| File | What it is |
|---|---|
| `pack-2.json` | Receipt of job 1 (pack-2): 5/5 found, PASS, quote 0.030 -> 0.040 |
| `pack-3.json` | Receipt of job 2 (pack-3): 4/5 found (B5 missed), PASS, repeat buyer, quote held at 0.040 |
| `live-run-2026-11-12.log` | The run's console output (local folder shown as `$EARNED_HOME`) |

The receipts are copied byte for byte from the run. A receipt holds no secret: the answer
key and salt are public once revealed on-chain. The buyer's key is not here. Each receipt
already holds the full review text and the TEE attestation, so the separate
`job-<id>.review.json` files are not needed to verify or replay.

Check them yourself (offline, no key):

```sh
node cli/earned.js verify recorded/pack-2.json           # see: REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official pack-2 request (prompt v1), regrade PASS.
node cli/earned.js verify recorded/pack-3.json           # see: REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official pack-3 request (prompt v1), regrade PASS.
node cli/earned.js verify recorded/pack-2.json --tamper  # see: FAIL: check 2 TEE signature covers this review
```

Offline verify can't prove the job, payment or tx hashes. Check those on the testnet explorer:

| Step | Job 1 (pack-2) | Job 2 (pack-3) |
|---|---|---|
| create (buyer locks the price) | [CUuEWusixATkE8yybm9CAm22tt6QDAsHxWf9oQEExksm](https://testnet.nearblocks.io/txns/CUuEWusixATkE8yybm9CAm22tt6QDAsHxWf9oQEExksm) | [GFkPH6NANwEKZNJB1xBSALwje3pnYAYzgS1F6WCUT1D1](https://testnet.nearblocks.io/txns/GFkPH6NANwEKZNJB1xBSALwje3pnYAYzgS1F6WCUT1D1) |
| accept (seller) | [6TvuZ7Z52NjE8xEDBvKuJm6dEVrpQmvWyj6HqfXARKVN](https://testnet.nearblocks.io/txns/6TvuZ7Z52NjE8xEDBvKuJm6dEVrpQmvWyj6HqfXARKVN) | [3UVF9yCwfypA6C3UfXQV7t23BBuqRDJrMp7y4wKjU59Y](https://testnet.nearblocks.io/txns/3UVF9yCwfypA6C3UfXQV7t23BBuqRDJrMp7y4wKjU59Y) |
| submit_review (signed TEE review) | [DXxtYrWFMzogDobRSyKLNS3s6PVYThjRA8TQpyB1YPsu](https://testnet.nearblocks.io/txns/DXxtYrWFMzogDobRSyKLNS3s6PVYThjRA8TQpyB1YPsu) | [B9cCSY47Wo7hsvBkyw4DuaW8x5SmR6Udgjf824dX6GpF](https://testnet.nearblocks.io/txns/B9cCSY47Wo7hsvBkyw4DuaW8x5SmR6Udgjf824dX6GpF) |
| reveal + settle (seller paid) | [9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB](https://testnet.nearblocks.io/txns/9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB) | [3skWKYL7tpPwtzgYcfrTkhgxDv4HaYdAMg9axFLNB5Rw](https://testnet.nearblocks.io/txns/3skWKYL7tpPwtzgYcfrTkhgxDv4HaYdAMg9axFLNB5Rw) |

The buyer account was created in
[CbXuiUougakPpWtFJPCaXxo4r7UV5JB6YgQWur5UY1h9](https://testnet.nearblocks.io/txns/CbXuiUougakPpWtFJPCaXxo4r7UV5JB6YgQWur5UY1h9).
After the run, `get_record` for the seller read passes 2, fails 0, unique_buyers 1, jobs 2
(quote 0.040). Later jobs move that record, so a fresh read today can differ.

The seller is no longer fresh, so this run can't be repeated with the same 0.030 -> 0.040 ->
0.040 sequence on this seller. `test/recorded.test.js` checks these files on every `npm test`.
