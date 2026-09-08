import { randomUUID } from 'node:crypto';
import { createMockChequebookJournal } from '../../dev/mock-chequebook.mjs';
import { json, launchTransferFixture, readJson } from './transfer-fixture.mjs';

export const historyInstanceId = '11111111-1111-4111-8111-111111111111';
export const historyReceipt = { kind: 'settled', receiptBlockNumber: '501', receiptBlockHash: `0x${'77'.repeat(32)}`,
  finalizedBlockNumber: '510', finalizedBlockHash: `0x${'88'.repeat(32)}` };

export async function launchHistoryFixture(t, count = 0) {
  let account = 7;
  let present = true;
  let override = null;
  let held = null;
  const records = [];
  const posts = [];
  const reads = [];
  const journal = createMockChequebookJournal({ profileFor: name => present ? { name, instance_id: historyInstanceId } : null,
    nodeFor: () => ({ ethereum: `0x${'11'.repeat(20)}`, bzz: '20000000000000000', xdai: '1000000000000000',
      chequebook: { address: `0x${'22'.repeat(20)}`, total: '10000000000000000', available: '10000000000000000' } }),
    userFor: () => account === null ? null : { id: account }, onSubmitted: operation => records.push(operation) });
  const fixture = await launchTransferFixture(t, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/auth/login' && req.method === 'POST') {
      const body = await readJson(req); account = body.username === 'operator-8' ? 8 : 7; return json(res, 200, {});
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') { account = null; res.writeHead(204); return res.end(); }
    if (account === null) return json(res, 401, { error: 'not_signed_in' });
    if (url.pathname === '/auth/session') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ id: account, username: `operator-${account}`, isAdmin: false, expiresAt: '2099-01-01T00:00:00.000Z' }));
    }
    if (url.pathname === '/profiles') return json(res, 503, { error: 'synthetic_unavailable' });
    if (url.pathname === '/config') return json(res, 200, { host: 'offline-fixture', srtPassphrase: null, chequebookFloorBzz: '0.5' });
    if (url.pathname === '/groups') return json(res, 200, { groups: [] });
    if (url.pathname === '/versions') return json(res, 200, []);
    if (url.pathname === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': synthetic connected\n\n'); }
    if (req.method === 'POST') posts.push(url.pathname);
    if (req.method === 'GET' && url.pathname.startsWith('/chequebook/')) {
      reads.push(req.url);
      if (held && url.pathname === held.path) {
        const hold = held; held = null;
        const snapshot = journal.detail(hold.id);
        hold.enter(); await hold.wait; return json(res, 200, snapshot);
      }
      const replacement = override?.(url);
      if (replacement) return json(res, replacement.status, replacement.body);
    }
    for (const [method, pattern, handler] of journal.routes) {
      const match = pattern.exec(url.pathname);
      if (method === req.method && match) return handler(req, res, match.slice(1));
    }
    return json(res, 404, {});
  });
  for (let index = 0; index < count; index++) {
    const response = await fetch(`${fixture.origin}/profiles/removed-profile/chequebook/deposit`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), profileInstanceId: historyInstanceId, expectedAccountId: 7, amount: '5000000000000000' }) });
    const admitted = await response.json();
    if (response.status !== 202) throw new Error('Synthetic history seed admission failed');
    journal.observeReceipt(admitted.operation.id, historyReceipt);
  }
  posts.length = 0;
  present = false;
  return { ...fixture, journal, records, posts, reads,
    override(value) { override = value; },
    holdOnce(id) {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      held = { path: `/chequebook/operations/${id}`, id, enter, wait };
      t.after(() => release());
      return { id, entered, release };
    } };
}
