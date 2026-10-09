/**
 * Public-ledger lookups. Ledger activity is a FACT about the address; ownership is never inferred.
 */
import type { Provider } from '../types';
import { ProviderError } from '../types';
import { makeRecord } from '../util';

export const blockstreamProvider: Provider = {
  id: 'blockstream',
  name: 'Blockstream Esplora (Bitcoin)',
  category: 'crypto',
  kind: 'live',
  reliability: 'authoritative',
  description: 'Bitcoin address statistics (transaction counts, received/spent totals) from the public Esplora API.',
  homepage: 'https://blockstream.info',
  docsUrl: 'https://github.com/Blockstream/esplora/blob/master/API.md',
  operations: [{ id: 'btc_address', label: 'Bitcoin ledger activity', targetTypes: ['crypto'], module: 'crypto', minDepth: 'standard' }],
  config: [],
  timeoutMs: 15000,
  maxRetries: 1,
  concurrency: 1,
  minIntervalMs: 500,
  async run(input, ctx) {
    if (input.subject.metadata.chain !== 'bitcoin') throw new ProviderError('not_applicable', 'Not a Bitcoin address.');
    const addr = input.subject.display.trim();
    const res = await ctx.http.request(`https://blockstream.info/api/address/${encodeURIComponent(addr)}`);
    const d = res.json<{ chain_stats: { funded_txo_count: number; funded_txo_sum: number; spent_txo_count: number; spent_txo_sum: number; tx_count: number } }>();
    const txs = await ctx.http.request(`https://blockstream.info/api/address/${encodeURIComponent(addr)}/txs`).then((r) => r.json<Array<{ txid: string; status: { block_time?: number } }>>()).catch(() => []);
    const latest = txs.find((t) => t.status.block_time)?.status.block_time;
    const s = d.chain_stats;
    const btc = (sats: number) => (sats / 1e8).toFixed(8);
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: `https://blockstream.info/address/${addr}`,
          title: `${addr}: ${s.tx_count} confirmed transaction(s), ${btc(s.funded_txo_sum)} BTC received`,
          description: `Spent ${btc(s.spent_txo_sum)} BTC; balance ${btc(s.funded_txo_sum - s.spent_txo_sum)} BTC at collection time.`,
          excerpt: JSON.stringify(s),
          entityType: 'crypto_address',
          normalizedValue: input.subject.value,
          category: 'crypto',
          claimType: 'FACT',
          events: latest ? [{ date: new Date(latest * 1000).toISOString(), precision: 'exact', kind: 'event', label: `Most recent confirmed transaction involving ${addr.slice(0, 10)}…` }] : [],
          metadata: { ...s, latestTxs: txs.slice(0, 5).map((t) => t.txid) },
          fingerprintKey: `btc:${addr}`,
          limitations: ['Ledger data shows activity only; it does not identify the owner.'],
          raw: { chain_stats: s, txs: txs.slice(0, 10) },
        }),
      ],
    };
  },
};

export const etherscanProvider: Provider = {
  id: 'etherscan',
  name: 'Etherscan (Ethereum)',
  category: 'crypto',
  kind: 'live',
  reliability: 'authoritative',
  description: 'Ethereum balance and first transaction via the Etherscan API V2.',
  homepage: 'https://etherscan.io',
  docsUrl: 'https://docs.etherscan.io/',
  operations: [{ id: 'eth_address', label: 'Ethereum ledger activity', targetTypes: ['crypto'], module: 'crypto', minDepth: 'standard' }],
  config: [{ env: 'ETHERSCAN_API_KEY', label: 'Etherscan API key' }],
  timeoutMs: 15000,
  maxRetries: 1,
  concurrency: 1,
  minIntervalMs: 400,
  async run(input, ctx) {
    if (input.subject.metadata.chain !== 'ethereum') throw new ProviderError('not_applicable', 'Not an Ethereum address.');
    const addr = input.subject.value;
    const key = encodeURIComponent(ctx.env.ETHERSCAN_API_KEY!);
    const base = 'https://api.etherscan.io/v2/api?chainid=1';
    const bal = (await ctx.http.request(`${base}&module=account&action=balance&address=${addr}&tag=latest&apikey=${key}`)).json<{ status: string; message: string; result: string }>();
    if (bal.status !== '1') throw new ProviderError(/api key/i.test(String(bal.result)) ? 'auth' : 'upstream_error', `Etherscan: ${etherscanReason(bal)}`);
    const first = (await ctx.http.request(`${base}&module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${key}`)).json<{ result: Array<{ timeStamp: string; hash: string }> | string }>();
    const firstTx = Array.isArray(first.result) ? first.result[0] : undefined;
    const eth = Number(BigInt(bal.result) / 10n ** 12n) / 1e6;
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: `https://etherscan.io/address/${addr}`,
          title: `${addr}: balance ${eth} ETH${firstTx ? `, first transaction ${new Date(Number(firstTx.timeStamp) * 1000).toISOString().slice(0, 10)}` : ', no transactions'}`,
          entityType: 'crypto_address',
          normalizedValue: addr,
          category: 'crypto',
          claimType: 'FACT',
          events: firstTx ? [{ date: new Date(Number(firstTx.timeStamp) * 1000).toISOString(), precision: 'exact', kind: 'event', label: 'First Ethereum transaction for address' }] : [],
          metadata: { balanceWei: bal.result, firstTx: firstTx?.hash ?? null },
          fingerprintKey: `eth:${addr}`,
          limitations: ['Ledger data shows activity only; it does not identify the owner.'],
          raw: { balance: bal.result, firstTx },
        }),
      ],
    };
  },
  async healthCheck(ctx) {
    const t = Date.now();
    const key = encodeURIComponent(ctx.env.ETHERSCAN_API_KEY!);
    const res = await ctx.http.request(`https://api.etherscan.io/v2/api?chainid=1&module=account&action=balance&address=0x${'0'.repeat(40)}&tag=latest&apikey=${key}`);
    const d = res.json<{ status: string; message: string; result: string }>();
    if (d.status !== '1') throw new ProviderError('auth', `Etherscan did not accept the key: ${etherscanReason(d)}`);
    return { status: 'healthy', message: 'Etherscan accepted the key.', latencyMs: Date.now() - t };
  },
};

/** Etherscan reports errors with HTTP 200, status "0" and the reason in `result` (e.g. "Invalid API Key (#err2)|…"). */
function etherscanReason(d: { message: string; result: unknown }): string {
  const reason = typeof d.result === 'string' && !/^\d+$/.test(d.result) ? d.result : d.message;
  return reason.split('|')[0]!.replace(/[A-Za-z0-9]{30,}/g, '[REDACTED]').slice(0, 160);
}

export const CRYPTO_PROVIDERS: Provider[] = [blockstreamProvider, etherscanProvider];
