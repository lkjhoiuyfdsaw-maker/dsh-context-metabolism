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

const sessionObservers = new WeakMap();

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
  sessionObservers.set(session, handlers);
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

function result(session, turn, name, args, value, isError = false, step = 1) {
  const callId = `call-${session.seq}`;
  const call = session.append('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) });
  return session.append('tool/result', { turn, step, message: createToolResultMessage({
    callId, content: [{ type: 'text', text: value }], isError,
  }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
}

async function finish(session, turn, kind = 'completed') {
  const event = session.append('turn/end', { turn, reason: { kind } });
  sessionObservers.get(session)?.get('session/event')?.(session, event);
  await Promise.resolve();
}

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
    sessionObservers.set(agent.session, handlers);
    await finish(agent.session, 1);
    assert(!has(agent.session.deriveMessages(), raw));
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
  await finish(session, 1);
  assert(has(await host.next(2), `[工具结果已代谢，原事件 ${receipt.seq}]`));
  const restored = runtime(Session.create(session.id, session.snapshotEvents()));
  assert.match(restored.notebook(), /按事件号核对原文/);
});

test('looks up tool calls by turn and reads the stable original reference after metabolism and replay', async () => {
  const session = Session.create('session-history-table');
  const host = runtime(session);
  const raw = 'original output '.repeat(1000);
  let original;
  for (let turn = 1; turn <= 8; turn++) {
    await host.next(turn);
    if (turn === 4) {
      original = result(session, turn, 'read_log', { query: 'needle' }, raw);
      result(session, turn, 'check_log', {}, 'failed', true);
    } else {
      result(session, turn, 'check_log', { turn }, `result ${turn}`);
    }
    await finish(session, turn);
  }
  const restored = runtime(Session.create(session.id, session.snapshotEvents()));
  const read = (ref, offset) => JSON.parse(restored.tool.execute({ action: 'read', ref, offset }, { agent: restored.agent }).text);
  const ref = `T4S1:${original.seq}`;
  const table = read('T4');
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0], { tool: 'read_log', input: '{"query":"needle"}', call: `T4S1:${original.seq - 1}`, result: ref });
  assert.equal(read(table.rows[1].result).isError, true);
  assert.equal(read(table.rows[0].call).text, table.rows[0].input);
  assert.equal(read(ref).input, table.rows[0].input);
  assert.equal(read(ref).text + read(ref, read(ref).nextOffset).text, raw);
  assert.throws(() => read(`T5S1:${original.seq}`), /不匹配/);
  assert.deepEqual(read().turns, { first: 5, last: 7 });
  assert.equal(read().rows.length, 3);
});

test('filters by step and exact tool name and reads mixed refs independently', async () => {
  const session = Session.create('session-history-filters');
  const host = runtime(session);
  await host.next(6);
  const early = result(session, 6, 'read-log', { term: 'early' }, 'early output');
  const late = result(session, 6, 'read-log', { term: 'late' }, 'late output '.repeat(900), false, 9);
  result(session, 6, 'read-log-extra', {}, 'other output', false, 9);
  await finish(session, 6);
  const restored = runtime(Session.create(session.id, session.snapshotEvents()));
  const read = (ref, offset) => JSON.parse(restored.tool.execute({ action: 'read', ref, offset }, { agent: restored.agent }).text);
  const lateRef = `T6S9:${late.seq}`;
  assert.deepEqual(read('T6-read-log').rows.map(row => row.result), [`T6S1:${early.seq}`, lateRef]);
  assert.equal(read('T6S9').rows.length, 2);
  assert.deepEqual(read('T6S9-read-log').rows.map(row => row.result), [lateRef]);
  assert.deepEqual(read('T6S8-read-log').rows, []);
  const batch = read(['T6S9-read-log', 'invalid', lateRef]).results;
  assert.deepEqual(batch.map(row => row.ref), ['T6S9-read-log', 'invalid', lateRef]);
  assert.deepEqual(batch[0].data, read('T6S9-read-log'));
  assert.match(batch[1].error, /格式/);
  assert.deepEqual(batch[2].data, read(lateRef));
  assert.equal(read(lateRef, batch[2].data.nextOffset).offset, 8000);
  assert.throws(() => read([lateRef], 1), /续读/);

  assert.equal(read('T6-read-log').rows[0].output, undefined);
  assert.deepEqual(read('T6-read-log-output').rows.map(row => row.result), [`T6S1:${early.seq}`, lateRef]);
  const outputs = read('T6-output').rows;
  assert.equal(outputs.length, 3);
  assert.ok(outputs.every(row => !Object.hasOwn(row, 'input')));
  assert.equal(outputs[0].output, 'early output');
  assert.deepEqual(read('T6S9-output').rows, outputs.slice(1));
  const [selected] = read('T6S9-read-log-output').rows;
  assert.equal(selected.result, lateRef);
  assert.equal(selected.output, read(lateRef).text);
  assert.equal(selected.nextOffset, 8000);
  assert.equal(selected.output + read(lateRef, selected.nextOffset).text, 'late output '.repeat(900));
  assert.deepEqual(read(lateRef.replace(':', ';')), read(lateRef));
  const mixed = read(['T6S9-read-log-output', 'T6-read-log-both', lateRef]).results;
  assert.deepEqual(mixed[0].data.rows, [selected]);
  assert.equal(mixed[1].data.rows[1].input, '{"term":"late"}');
  assert.equal(mixed[1].data.rows[1].output, selected.output);
  assert.equal(mixed[2].data.input, mixed[1].data.rows[1].input);
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
  await finish(session, 1);
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
  await finish(session, 1);
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
  await finish(session, 1);
  assert(has(await host.next(2), 'old receipt'));
  changeMarks(host, 2, { action: 'settle', includeHistory: true, summary: 'Historical cleanup requested.' });
  await finish(session, 2);
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
  await finish(session, 1);
  assert(!has(session.deriveMessages(), raw));
  assert(has(session.deriveMessages(), `[工具结果已代谢，原事件 ${original.seq}]`));
  const second = await host.next(2);
  assert(!has(second, raw));
  assert(has(second, `[工具结果已代谢，原事件 ${original.seq}]`));
  assert(has(second, evidence));
  assert.equal(session.eventAt(original.seq).data.message.content[0].text, raw);
  assert.deepEqual(JSON.parse(session.eventAt(original.sourceEventSeqs[0]).data.arguments), { path: 'test.log' });
  await finish(session, 2);
  const third = await host.next(3);
  assert(!has(third, raw));
  assert(has(third, evidence));
  result(session, 3, 'read_log', {}, 'small');
  const marked = JSON.parse(host.tool.execute({ action: 'list' }, { agent: host.agent }).text);
  assert.equal(marked.find(row => row.seq === mark.seq).reason, 'Compare exact results');
  assert.throws(() => changeMarks(host, 3, { action: 'release', seqs: [original.seq] }), /已有保留标注/);
  changeMarks(host, 3, { action: 'release', seqs: [mark.seq] });
  await finish(session, 3);
  const fourth = await host.next(4);
  assert(!has(fourth, evidence));
  assert(has(fourth, 'small'));
  host.disable();
  assert.equal(host.tool, undefined);
  host = runtime(session, false);
  await finish(session, 4);
  await host.next(5);
  const newRaw = 'new output '.repeat(200);
  result(session, 5, 'read_log', {}, newRaw);
  await finish(session, 5);
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
    await finish(session, turn - 1);
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
  await finish(session, 5);
  await host.next(6);
  assert.equal(host.review(), '');
  await finish(session, 6);
  await host.next(7);
  assert(host.review().includes(`事件 ${later.seq}）`));
  changeMarks(host, 7, { action: 'release', seqs: [later.seq] });
  await finish(session, 7);
  await host.next(8);
  await finish(session, 8);
  await host.next(9);
  assert.equal(host.review(), '');
});

test('metabolizes errored and aborted turns at turn end and preserves replacements on replay', async () => {
  const session = Session.create('metabolism-test-failure');
  const host = runtime(session);
  await host.next(1);
  const evidence = 'marked evidence '.repeat(200);
  const marked = result(session, 1, 'read_log', {}, evidence);
  changeMarks(host, 1, { action: 'mark', keep: [{ seq: marked.seq, reason: 'Keep exact evidence' }] });
  const oldRaw = 'errored output '.repeat(200);
  const old = result(session, 1, 'read_log', {}, oldRaw);
  await finish(session, 1, 'error');
  session.append('turn/start', { turn: 2 });
  const recent = result(session, 2, 'read_log', {}, 'aborted output '.repeat(200));
  await finish(session, 2, 'aborted');

  const replayed = Session.create(session.id, session.snapshotEvents());
  for (const event of [old, recent]) {
    assert(has(replayed.deriveMessages(), `[工具结果已代谢，原事件 ${event.seq}]`));
  }
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
  await finish(replayed, 3);
  const fourth = await resumed.next(4);
  assert(has(fourth, `[工具结果已代谢，原事件 ${marked.seq}]`));
  assert(!has(fourth, evidence));
});
