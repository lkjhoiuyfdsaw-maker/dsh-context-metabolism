import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from './metabolism-host.mjs';

const installed = process.env.DSH_PACKAGES_DIR
  ? resolve(process.env.DSH_PACKAGES_DIR)
  : resolve(process.env.LOCALAPPDATA ?? '.', 'Deepseek Harness Desktop/resources/dsh/node_modules/@deepseek-ai');
const load = packageName => import(pathToFileURL(resolve(installed, packageName, 'lib/index.js')));
const { Session } = await load('dsh-session');
const { createToolResultMessage, createUserMessage } = await load('dsh-llm');

function runtime(session, enabled = true) {
  const handlers = new Map();
  let definition;
  const contributions = new Map();
  let dispose;
  const agent = { session, ctx: { tools: { register(tool) {
    definition = tool;
    return () => { definition = undefined; };
  } } } };
  apply({
    agents: { list: () => [agent] },
    systemPrompt: { context: contribution => contributions.set(contribution.name, contribution) },
    effect: install => { dispose = install(); },
    on: (name, handler) => handlers.set(name, handler),
    tokenMeter: { estimateMessage: message => JSON.stringify(message.content).length },
    logger: { warn: assert.fail },
  }, { sessionId: session.id, enabled });
  return {
    agent,
    get tool() { return definition; },
    review: () => contributions.get('context-metabolism:review').text({ agent }),
    notebook: (subject = agent) => contributions.get('context-metabolism:notebook').text({ agent: subject }),
    disable() { dispose?.(); handlers.clear(); },
    async next(turn) {
      session.append('turn/start', { turn });
      const request = () => session.deriveMessages();
      return handlers.get('agent/request')?.({ agent, turn, step: 1 }, request) ?? request();
    },
  };
}

function result(session, turn, name, args, value, isError = false) {
  const callId = `call-${session.seq}`;
  const call = session.append('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) });
  return session.append('tool/result', { turn, step: 1, message: createToolResultMessage({
    callId, content: [{ type: 'text', text: value }], isError,
  }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
}

const finish = (session, turn, kind = 'completed') => session.append('turn/end', { turn, reason: { kind } });

test('all-agent mode registers existing and newly created agents and settles each independently', async () => {
  const handlers = new Map();
  const definitions = new Map();
  const makeAgent = id => ({ session: Session.create(id), ctx: { tools: { register(tool) {
    definitions.set(id, tool);
    return () => definitions.delete(id);
  } } } });
  const existing = makeAgent('session-existing');
  const created = makeAgent('session-created');
  let dispose;
  apply({
    agents: { list: () => [existing] },
    systemPrompt: { context() {} },
    effect: install => { dispose = install(); },
    on: (name, handler) => handlers.set(name, handler),
    tokenMeter: { estimateMessage: message => JSON.stringify(message.content).length },
    logger: { warn: assert.fail },
  });
  assert(definitions.has(existing.session.id));
  handlers.get('agent/created')({ agent: created });
  assert(definitions.has(created.session.id));
  const next = (agent, turn) => {
    agent.session.append('turn/start', { turn });
    return handlers.get('agent/request')({ agent, turn, step: 1 }, () => agent.session.deriveMessages());
  };
  const raw = 'per-session output '.repeat(200);
  const args = { action: 'settle', summary: 'Checked output.', keep: [] };
  assert.throws(() => definitions.get(existing.session.id).execute(args, { agent: created }), /当前会话/);
  for (const agent of [existing, created]) {
    await next(agent, 1);
    result(agent.session, 1, 'read_log', {}, raw);
    finish(agent.session, 1);
    assert(!has(await next(agent, 2), raw));
  }
  dispose();
  assert.equal(definitions.size, 0);
});

function changeMarks(host, turn, args) {
  const receipt = host.tool.execute(args, { agent: host.agent });
  return result(host.agent.session, turn, host.tool.name, args, receipt.text);
}
const has = (messages, value) => messages.some(message => message.content.some(block => block.text === value));

test('reads shadowed history, pages text, and retains only the distilled notebook entry', async () => {
  const session = Session.create('session-event-read');
  const host = runtime(session);
  await host.next(1);
  const original = '原文'.repeat(4500);
  const user = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: original }] }), { surfaceOp: 'append' });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '摘要' }] }), { surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: user.seq }, sourceEventSeqs: [user.seq] });
  assert(!session.surface.nodes.includes(user.seq));
  const read = { action: 'read', seq: user.seq };
  const receipt = changeMarks(host, 1, read);
  const first = JSON.parse(receipt.data.message.content[0].text);
  const last = JSON.parse(host.tool.execute({ ...read, offset: first.nextOffset }, { agent: host.agent }).text);
  assert.equal(first.text + last.text, original);
  assert.equal(last.nextOffset, undefined);
  assert.throws(() => host.tool.execute({ ...read, seq: session.seq }, { agent: host.agent }), /文字原文/);
  const note = { action: 'remember', key: 'history-check', seq: receipt.seq, note: '按事件号核对原文。' };
  changeMarks(host, 1, note);
  finish(session, 1);
  assert(has(await host.next(2), `[工具结果已代谢，原事件 ${receipt.seq}]`));
  const restored = runtime(Session.create(session.id, session.snapshotEvents()));
  assert.match(restored.notebook(), /按事件号核对原文/);
});

test('notebook survives metabolism and replay; updates, forgetting, budget and scope stay isolated', async () => {
  let session = Session.create('session-notebook');
  let host = runtime(session);
  await host.next(1);
  const raw = 'original tool body '.repeat(200);
  const original = result(session, 1, 'read_log', {}, raw);
  const entry = { action: 'remember', key: 'test-log', seq: original.seq, note: 'When testing, check the exit code.' };
  assert.equal(host.notebook(), '');
  assert.throws(() => changeMarks(host, 1, { ...entry, seq: 9999 }), /原始工具结果/);
  result(session, 1, host.tool.name, { ...entry, key: 'legacy-removed' }, '已写入全局注入。');
  result(session, 1, host.tool.name, { action: 'forget', key: 'legacy-removed' }, '已移除全局注入条目。');
  result(session, 1, host.tool.name, entry, '已写入全局注入。');
  assert.match(host.notebook(), /^超级注入（本会话的小本本）/);
  assert.deepEqual(JSON.parse(host.tool.execute({ action: 'notes' }, { agent: host.agent }).text).map(note => note.key), [entry.key]);
  finish(session, 1);
  const next = await host.next(2);
  assert(!has(next, raw));
  assert(has(next, `[工具结果已代谢，原事件 ${original.seq}]`));
  assert(host.notebook().includes(entry.note));
  assert.equal(host.notebook({ session: Session.create('other-session') }), '');
  session = Session.create(session.id, session.snapshotEvents());
  host = runtime(session);
  assert(host.notebook().includes(entry.note));
  const fresh = result(session, 2, 'read_log', {}, 'updated source');
  const updated = { ...entry, seq: fresh.seq, note: 'When testing, check skipped cases as well.' };
  changeMarks(host, 2, updated);
  assert(!host.notebook().includes(entry.note));
  assert.deepEqual(JSON.parse(host.tool.execute({ action: 'notes' }, { agent: host.agent }).text), [{ key: updated.key, seq: updated.seq, note: updated.note }]);
  for (let i = 0; i < 4; i++) changeMarks(host, 2, { ...updated, key: `extra-${i}`, note: 'x'.repeat(240) });
  assert.throws(() => changeMarks(host, 2, { ...updated, key: 'excess', note: 'x'.repeat(240) }), /已满/);
  changeMarks(host, 2, { action: 'forget', key: updated.key });
  assert(!host.notebook().includes(updated.note));
  for (let i = 0; i < 4; i++) changeMarks(host, 2, { action: 'forget', key: `extra-${i}` });
  assert.equal(host.notebook(), '');
});

test('outbound projection retires stale notebook snapshots without removing other sections', async () => {
  const session = Session.create('session-note-snapshot');
  const host = runtime(session);
  await host.next(1);
  const raw = result(session, 1, 'read_log', {}, 'short source');
  const entry = { action: 'remember', key: 'source', seq: raw.seq, note: 'old notebook entry' };
  changeMarks(host, 1, entry);
  const snapshot = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${host.notebook()}\nworking directory` }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: [
      { name: 'context-metabolism:notebook', text: host.notebook() },
      { name: 'cwd', text: 'working directory' },
    ] },
  }), { surfaceOp: 'append' });
  changeMarks(host, 1, { ...entry, note: 'new notebook entry' });
  finish(session, 1);
  const next = await host.next(2);
  assert(!JSON.stringify(next).includes(entry.note) || !next.some(m => m.source.kind === 'runtime-context' && JSON.stringify(m).includes(entry.note)));
  assert(next.some(m => m.source.kind === 'runtime-context' && m.content[0].text.endsWith('working directory')));
  assert(session.eventAt(snapshot.seq).data.content[0].text.includes(entry.note));
  assert(host.notebook().includes('new notebook entry'));
});

test('explicit history settlement replaces old short receipts and preserves the original event', async () => {
  const session = Session.create('session-metabolism-history');
  const host = runtime(session);
  await host.next(1);
  const old = result(session, 1, 'read_log', {}, 'old receipt');
  finish(session, 1);
  assert(has(await host.next(2), 'old receipt'));
  changeMarks(host, 2, { action: 'settle', includeHistory: true, summary: 'Historical cleanup requested.' });
  finish(session, 2);
  assert(has(await host.next(3), `[工具结果已代谢，原事件 ${old.seq}]`));
  assert.equal(session.eventAt(old.seq).data.message.content[0].text, 'old receipt');
});

test('projects the next request using native session replacement and preserves history after disable', async () => {
  const session = Session.create('metabolism-test');
  let host = runtime(session);
  const raw = 'disposable output '.repeat(200);
  const evidence = 'marked evidence '.repeat(200);
  await host.next(1);
  const original = result(session, 1, 'read_log', { path: 'test.log' }, raw);
  const mark = result(session, 1, 'read_log', { path: 'evidence.log' }, evidence);
  const list = host.tool.execute({ action: 'list' }, { agent: host.agent });
  assert.deepEqual(JSON.parse(list.text).map(row => row.seq), [original.seq, mark.seq]);
  changeMarks(host, 1, { action: 'mark', keep: [{ seq: mark.seq, reason: 'Compare exact results' }] });
  assert(has(session.deriveMessages(), raw));
  finish(session, 1);
  const second = await host.next(2);
  assert(!has(second, raw));
  assert(has(second, `[工具结果已代谢，原事件 ${original.seq}]`));
  assert(has(second, evidence));
  assert.equal(session.eventAt(original.seq).data.message.content[0].text, raw);
  assert.deepEqual(JSON.parse(session.eventAt(original.sourceEventSeqs[0]).data.arguments), { path: 'test.log' });
  finish(session, 2);
  const third = await host.next(3);
  assert(!has(third, raw));
  assert(has(third, evidence));
  result(session, 3, 'read_log', {}, 'small');
  const marked = JSON.parse(host.tool.execute({ action: 'list' }, { agent: host.agent }).text);
  assert.equal(marked.find(row => row.seq === mark.seq).reason, 'Compare exact results');
  assert.throws(() => changeMarks(host, 3, { action: 'release', seqs: [original.seq] }), /已有保留标注/);
  changeMarks(host, 3, { action: 'release', seqs: [mark.seq] });
  finish(session, 3);
  const fourth = await host.next(4);
  assert(!has(fourth, evidence));
  assert(has(fourth, 'small'));
  host.disable();
  assert.equal(host.tool, undefined);
  host = runtime(session, false);
  finish(session, 4);
  await host.next(5);
  const newRaw = 'new output '.repeat(200);
  result(session, 5, 'read_log', {}, newRaw);
  finish(session, 5);
  const sixth = await host.next(6);
  assert(!has(sixth, raw));
  assert(!has(sixth, evidence));
  assert(has(sixth, newRaw));
  const replayed = Session.create(session.id, session.snapshotEvents());
  assert.deepEqual(replayed.deriveMessages(), session.deriveMessages());
});

test('reviews active marks every two turns and stops after release', async () => {
  const session = Session.create('session-review');
  const host = runtime(session);
  await host.next(1);
  const marked = result(session, 1, 'skill', {}, 'marked body '.repeat(100));
  const unmarked = result(session, 1, 'read_log', {}, 'short');
  assert.equal(host.review(), '');
  changeMarks(host, 1, { action: 'mark', keep: [{ seq: marked.seq, reason: 'Needed for comparison' }] });
  for (let turn = 2; turn <= 5; turn++) {
    finish(session, turn - 1);
    await host.next(turn);
    const expected = turn % 2 === 1;
    const prompt = host.review();
    assert.equal(Boolean(prompt), expected);
    if (expected) {
      assert(prompt.includes(`事件 ${marked.seq}）`));
      assert(!prompt.includes(`事件 ${unmarked.seq}）`));
      assert.equal(host.review(), prompt);
    }
  }
  const later = result(session, 5, 'skill', {}, 'later body '.repeat(100));
  changeMarks(host, 5, { action: 'mark', keep: [{ seq: later.seq, reason: 'Still in use' }] });
  changeMarks(host, 5, { action: 'release', seqs: [marked.seq] });
  finish(session, 5);
  await host.next(6);
  assert.equal(host.review(), '');
  finish(session, 6);
  await host.next(7);
  assert(host.review().includes(`事件 ${later.seq}）`));
  changeMarks(host, 7, { action: 'release', seqs: [later.seq] });
  finish(session, 7);
  await host.next(8);
  finish(session, 8);
  await host.next(9);
  assert.equal(host.review(), '');
});

test('automatically catches up on results left by interrupted turns after replay', async () => {
  const session = Session.create('metabolism-test-failure');
  const host = runtime(session);
  await host.next(1);
  const evidence = 'marked evidence '.repeat(200);
  const marked = result(session, 1, 'read_log', {}, evidence);
  changeMarks(host, 1, { action: 'mark', keep: [{ seq: marked.seq, reason: 'Keep exact evidence' }] });
  const oldRaw = 'errored output '.repeat(200);
  const old = result(session, 1, 'read_log', {}, oldRaw);
  finish(session, 1, 'error');
  session.append('turn/start', { turn: 2 });
  const recent = result(session, 2, 'read_log', {}, 'aborted output '.repeat(200));
  finish(session, 2, 'aborted');

  const replayed = Session.create(session.id, session.snapshotEvents());
  const resumed = runtime(replayed);
  const third = await resumed.next(3);
  for (const event of [old, recent]) {
    assert(has(third, `[工具结果已代谢，原事件 ${event.seq}]`));
    assert(!has(third, event.data.message.content[0].text));
  }
  assert(has(third, evidence));
  const read = resumed.tool.execute({ action: 'read', seq: old.seq }, { agent: resumed.agent });
  assert.equal(JSON.parse(read.text).text, oldRaw);

  changeMarks(resumed, 3, { action: 'release', seqs: [marked.seq] });
  finish(replayed, 3);
  const fourth = await resumed.next(4);
  assert(has(fourth, `[工具结果已代谢，原事件 ${marked.seq}]`));
  assert(!has(fourth, evidence));
});
