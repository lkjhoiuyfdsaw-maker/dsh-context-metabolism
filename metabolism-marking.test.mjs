import assert from 'node:assert/strict';
import test from 'node:test';
import { projectResults } from './metabolism-marking.mjs';

const result = (seq, turn, content, callId = `call-${seq}`) => ({
  seq, turn, message: { role: 'tool', source: { kind: 'tool', callId }, content },
});
const text = value => [{ type: 'text', text: value }];
const request = [
  { seq: 9, turn: 1, message: { role: 'user', content: text('Keep the pending ID') } },
  { seq: 10, turn: 1, message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'call-11' }, { type: 'tool-call', callId: 'call-12' }] } },
  result(11, 1, text('discard routine output')),
  result(12, 1, text('job-437')),
  result(13, 1, [{ type: 'image', data: 'discard image bytes' }]),
  result(14, 1, text('discard resolved error')),
  { seq: 15, turn: 1, message: { role: 'assistant', content: text('Continue job-437') } },
  result(16, 1, text('ledger write receipt')),
  result(23, 2, text('same-turn result needed now')),
];
const mark = { turn: 1, keep: [{ seq: 12, reason: 'Poll pending job' }] };

test('keeps only marked historical payloads and preserves tool pairing and source data', () => {
  const baseline = structuredClone(request);
  const next = projectResults(request, 2, [mark]);
  assert.deepEqual(next.map(item => item.seq), request.map(item => item.seq));
  for (const seq of [9, 10, 12, 15, 23]) {
    assert.deepEqual(next.find(item => item.seq === seq), request.find(item => item.seq === seq));
  }
  for (const seq of [11, 13, 14, 16]) {
    const placeholder = next.find(item => item.seq === seq);
    assert.deepEqual(placeholder.message.source, request.find(item => item.seq === seq).message.source);
    assert.deepEqual(placeholder.message.content, text(`[原始工具结果见会话事件 ${seq}]`));
  }
  assert.deepEqual(request, baseline);
});

test('an empty keep list differs from a missing settlement', () => {
  assert.deepEqual(projectResults(request, 2, []), request);
  const next = projectResults(request, 2, [{ turn: 1, keep: [] }]);
  assert.deepEqual(next.find(item => item.seq === 12).message.content, text('[原始工具结果见会话事件 12]'));
});

test('marking expires after one turn unless explicitly renewed', () => {
  const next = projectResults(request, 3, [mark, { turn: 2, keep: [] }]);
  assert.deepEqual(next.find(item => item.seq === 12).message.content, text('[原始工具结果见会话事件 12]'));
  const renewed = projectResults(request, 3, [mark, { turn: 2, keep: [{ seq: 12, reason: 'Job still running' }] }]);
  assert.strictEqual(renewed.find(item => item.seq === 12), request.find(item => item.seq === 12));
});

test('a skipped or invalid settlement leaves earlier decisions in effect', () => {
  const invalid = { turn: 2, keep: [{ seq: 404, reason: 'Missing result' }] };
  for (const settlements of [[mark], [mark, invalid]]) {
    const next = projectResults(request, 3, settlements);
    assert.deepEqual(next.find(item => item.seq === 11).message.content, text('[原始工具结果见会话事件 11]'));
    assert.strictEqual(next.find(item => item.seq === 12), request.find(item => item.seq === 12));
    assert.strictEqual(next.find(item => item.seq === 23), request.find(item => item.seq === 23));
  }
  const released = projectResults(request, 4, [{ turn: 3, keep: [] }, mark]);
  assert.deepEqual(released.find(item => item.seq === 12).message.content, text('[原始工具结果见会话事件 12]'));
});

test('an invalid or unconfirmed settlement leaves the affected turn intact', () => {
  for (const keep of [[{ seq: 9, reason: 'not a tool result' }], [{ seq: 23, reason: 'future result' }], [{ seq: 12, reason: ' ' }], [{ seq: 404, reason: 'missing' }]]) {
    assert.deepEqual(projectResults(request, 2, [{ turn: 1, keep }]), request);
  }
  assert.deepEqual(projectResults(request, 2, [mark, mark]), request);
});

test('keeps research material through repeated review until the agent stops renewing', () => {
  const evidence = result(41, 1, text('Section 1: applies by default. Section 2: exceptions depend on Section 3. Section 3: exceptions expire after review.'));
  const entries = [evidence];
  const retain = turn => ({ turn, keep: [{ seq: 41, reason: 'Compare exact cross-references across sections' }] });
  for (const nextTurn of [2, 3, 4]) {
    const settlements = Array.from({ length: nextTurn - 1 }, (_, i) => retain(i + 1));
    assert.strictEqual(projectResults(entries, nextTurn, settlements)[0], evidence);
  }
  const released = projectResults(entries, 5, [retain(1), retain(2), retain(3), { turn: 4, keep: [] }]);
  assert.deepEqual(released[0].message.content, text('[原始工具结果见会话事件 41]'));
  assert.match(evidence.message.content[0].text, /exceptions expire after review/);
});

test('retains a marked image or failure verbatim when the next step needs it', () => {
  const next = projectResults(request, 2, [{ turn: 1, keep: [{ seq: 13, reason: 'Compare image' }, { seq: 14, reason: 'Inspect error' }] }]);
  for (const seq of [13, 14]) assert.strictEqual(next.find(item => item.seq === seq), request.find(item => item.seq === seq));
});
