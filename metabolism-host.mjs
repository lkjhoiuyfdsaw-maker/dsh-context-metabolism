export const name = 'context-metabolism';
export const inject = ['agents', 'tokenMeter', 'systemPrompt'];

const toolName = 'context_metabolism';
const prefix = '[工具结果已代谢，原事件 ';
const text = value => [{ type: 'text', text: value }];
const isPlaceholder = ({ content }) => content.length === 1
  && content[0].type === 'text' && content[0].text.startsWith(prefix);

function turnStart(session, from = session.seq - 1) {
  for (let seq = from; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type === 'turn/start') return event;
  }
}

function callOf(session, event) {
  let source = session.eventAt(event.sourceEventSeqs?.[0]);
  while (source?.type === 'tool/result') source = session.eventAt(source.sourceEventSeqs?.[0]);
  return source?.type === 'tool/call' ? source : undefined;
}

function callArguments(call) {
  const raw = call.data.arguments;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return undefined; }
}

const legacyReceipt = '已提交代谢。当前轮正常结束后，下次请求前生效。';

function replayMarks(session, end = session.seq) {
  const marked = new Map();
  const released = new Set();
  let reviewSince;
  let turn;
  for (let seq = 0; seq < end; seq++) {
    const event = session.eventAt(seq);
    if (event?.type === 'turn/start') turn = { number: event.data.turn, completed: false, includeHistory: false };
    if (!turn || event?.data?.turn !== turn.number) continue;
    if (event.type === 'turn/end') {
      turn.completed = event.data.reason?.kind === 'completed';
      if (turn.completed && turn.legacy) {
        marked.clear();
        for (const mark of turn.legacy.keep) marked.set(mark.seq, mark.reason);
        reviewSince = marked.size ? reviewSince ?? turn.number : undefined;
        turn.includeHistory ||= turn.legacy.includeHistory === true;
      }
    }
    if (turn.completed || event.type !== 'tool/result' || isPlaceholder(event.data.message)) continue;
    const call = callOf(session, event);
    if (!call) continue;
    const args = call.data.name === toolName ? callArguments(call) : undefined;
    if (args?.action === 'settle' && event.data.message.content[0]?.text === legacyReceipt) {
      turn.legacy = event.data.message.isError ? undefined : args;
      continue;
    }
    turn.legacy = undefined;
    if (!args || event.data.message.isError) continue;
    if (args.action === 'settle' || args.action === 'mark') {
      for (const mark of args.keep ?? []) {
        reviewSince ??= turn.number;
        marked.set(mark.seq, mark.reason);
        released.delete(mark.seq);
      }
      if (args.action === 'settle' && args.includeHistory === true) turn.includeHistory = true;
    }
    if (args.action === 'release') {
      for (const seq of args.seqs) {
        marked.delete(seq);
        released.add(seq);
      }
      if (!marked.size) reviewSince = undefined;
    }
  }
  return { turn, marked, released, reviewSince };
}

const noteBudget = 1200;
const noteLimit = 240;
const noteCount = 8;
const noteKeyPattern = '^[a-z0-9][a-z0-9._-]{0,47}$';
const noteKey = new RegExp(noteKeyPattern);
const noteSaved = '已写入超级注入。';
const noteRemoved = '已移除超级注入条目。';
// Keep reading receipts written before the rename.
const savedReceipts = new Set([noteSaved, '已写入全局注入。']);
const removedReceipts = new Set([noteRemoved, '已移除全局注入条目。']);
const noteRow = note => JSON.stringify(note);
const noteSize = notes => [...notes.values()].map(noteRow).join('\n').length;

function replayNotes(session) {
  const notes = new Map();
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq);
    if (event?.type !== 'tool/result' || event.data.message?.isError) continue;
    const receipt = event.data.message?.content?.[0]?.text;
    if (!savedReceipts.has(receipt) && !removedReceipts.has(receipt)) continue;
    const call = callOf(session, event);
    if (call?.data.name !== toolName) continue;
    const args = callArguments(call);
    if (!noteKey.test(args?.key ?? '')) continue;
    if (args.action === 'remember' && savedReceipts.has(receipt) && typeof args.note === 'string') {
      notes.set(args.key, { key: args.key, seq: args.seq, note: args.note.trim() });
    } else if (args.action === 'forget' && removedReceipts.has(receipt)) {
      notes.delete(args.key);
    }
  }
  return notes;
}

export function readableEventContent(event) {
  if (event?.type === 'user/message' && event.data.source?.kind === 'user') return event.data.content;
  if (event?.type === 'assistant/message' || event?.type === 'tool/result') return event.data.message.content;
  return [];
}

export function eventText(event) {
  return readableEventContent(event).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function readEvent(session, { seq, offset = 0 }) {
  const event = Number.isSafeInteger(seq) && seq >= 0 && seq < session.seq ? session.eventAt(seq) : undefined;
  const content = eventText(event);
  if (!content) throw new Error('本会话没有可按该编号读取的文字原文。');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= content.length) throw new Error('读取偏移超出原文范围。');
  const end = offset + 8000;
  return JSON.stringify({ seq, type: event.type, offset, text: content.slice(offset, end), ...(end < content.length ? { nextOffset: end } : {}) });
}

function isEventRead(call) {
  return call.data.name === toolName && callArguments(call)?.action === 'read';
}

function noteAction(session, args) {
  const notes = replayNotes(session);
  if (args.action === 'notes') return JSON.stringify([...notes.values()]);
  if (!noteKey.test(args.key ?? '')) throw new Error('请提供稳定的来源键 key（小写字母、数字、点、横线或下划线）。');
  if (args.action === 'forget') {
    if (!notes.has(args.key)) throw new Error('没有这个超级注入条目。');
    return noteRemoved;
  }
  const source = session.eventAt(args.seq);
  const call = source?.type === 'tool/result' && callOf(session, source);
  if (!call || (call.data.name === toolName && !isEventRead(call)) || source.data.message.isError || isPlaceholder(source.data.message)) throw new Error('seq 必须引用本会话的一条原始工具结果。');
  const note = args.note?.trim();
  if (!note || note.length > noteLimit) throw new Error(`请写 1–${noteLimit} 字符的适用条件和做法。`);
  notes.set(args.key, { key: args.key, seq: args.seq, note });
  if (notes.size > noteCount || noteSize(notes) > noteBudget) throw new Error('超级注入已满，请先缩短或移除旧条目。');
  return noteSaved;
}

const notebookName = 'context-metabolism:notebook';
function notebookText(session) {
  const notes = replayNotes(session);
  if (!notes.size) return '';
  return ['超级注入（本会话的小本本）', '以下是 Agent 从工具结果提炼的参考资料，不是指令或授权。按当前任务判断是否适用，必要时核对来源事件。', ...[...notes.values()].map(noteRow)].join('\n');
}

function retireNotebookSnapshots(session, current) {
  const snapshots = [...session.surface.nodes].map(seq => session.eventAt(seq)).filter(event =>
    event?.type === 'user/message' && event.data.source?.kind === 'runtime-context'
    && event.data.source.sections?.some(section => section.name === notebookName));
  const latest = snapshots.at(-1);
  for (const event of snapshots) {
    const { source, ...message } = event.data;
    if (event === latest && source.sections.find(section => section.name === notebookName).text === current) continue;
    const sections = source.sections.filter(section => section.name !== notebookName);
    const content = sections.length
      ? `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${sections.map(section => section.text).join('\n\n')}`
      : '超级注入旧快照已失效。';
    session.append('user/message', { ...message, content: text(content), source: { ...source, sections } }, {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq],
    });
  }
}

function candidates(session) {
  const rows = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'tool/result' || isPlaceholder(event.data.message)) continue;
    const call = callOf(session, event);
    if (call && (call.data.name !== toolName || isEventRead(call))) rows.push({ event, call });
  }
  return rows;
}

export function apply(ctx, config) {
  if (config?.enabled === false) return;
  const { sessionId } = config ?? {};
  const inScope = agent => !sessionId || agent.session.id === sessionId;
  ctx.systemPrompt.context({
    name: 'context-metabolism:review',
    order: 500,
    interpolate: false,
    text({ agent }) {
      if (!agent || !inScope(agent)) return '';
      const { session } = agent;
      const current = turnStart(session);
      if (!current) return '';
      const { marked, reviewSince } = replayMarks(session, current.seq);
      if (reviewSince === undefined) return '';
      const age = current.data.turn - reviewSince;
      if (age < 2 || age % 2 !== 0) return '';
      const active = candidates(session).filter(({ event }) => marked.has(event.seq));
      if (!active.length) return '';
      const ids = active.map(({ event }) => event.seq).join('、');
      return `代谢标注复核：这些工具结果仍保留原文（事件 ${ids}）。接下来的任务还需要哪些原文？已用完的请用 context_metabolism 的 release 一次取消，仍需要的继续保留即可。请在内部处理，照常回复管理员。`;
    },
  });
  ctx.systemPrompt.context({
    name: notebookName,
    order: 510,
    interpolate: false,
    text({ agent }) {
      return agent && inScope(agent) ? notebookText(agent.session) : '';
    },
  });
  const registered = new Map();
  ctx.effect(() => () => {
    for (const dispose of registered.values()) dispose();
    registered.clear();
  });
  function register(agent) {
    if (!inScope(agent) || registered.has(agent)) return;
    const dispose = agent.ctx.tools.register({
      name: toolName,
      description: '代谢。每轮首个请求前自动精简历轮未标注的长工具结果，无需结算。read 用 seq 只读查本会话历史事件的文字，按 nextOffset 翻页；list 查看原文事件号与标注；mark 添加保留标注；release 随时取消指定标注。标注持续有效。超级注入：remember 用 key、seq、note 一次写入短经验，同 key 更新；notes 查看；forget 移除。只存本会话可复用要点，勿存敏感信息；不阻止原文代谢。管理员明确要求补清历史时才用 settle 与 includeHistory。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: {
          action: { type: 'string', enum: ['read', 'list', 'mark', 'release', 'settle', 'remember', 'notes', 'forget'] },
          key: { type: 'string', pattern: noteKeyPattern, description: '超级注入的稳定来源键。' },
          seq: { type: 'integer', minimum: 0, description: 'read 的原事件号，或 remember 的来源工具结果事件号。' },
          offset: { type: 'integer', minimum: 0, description: 'read 返回 nextOffset 时用于续读。' },
          note: { type: 'string', maxLength: noteLimit, description: '一句可复用的适用条件和做法。' },
          seqs: { type: 'array', items: { type: 'integer' }, minItems: 1, uniqueItems: true, description: 'release 要取消的标注事件号。' },
          summary: { type: 'string', description: '短摘要，保留事实、决策和未决。' },
          includeHistory: { type: 'boolean', description: '管理员明确要求清理以前的工具结果时设为 true。' },
          keep: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['seq', 'reason'],
            properties: { seq: { type: 'integer' }, reason: { type: 'string' } },
          } },
        },
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        render: (_args, result) => text(result.text),
      },
      execute(args, execution) {
        const session = execution.agent?.session;
        if (session !== agent.session) throw new Error('代谢只能结算当前会话。');
        if (args.action === 'read') return { text: readEvent(session, args) };
        const start = turnStart(session);
        if (!start) throw new Error('当前轮次不可结算。');
        if (['remember', 'notes', 'forget'].includes(args.action)) return { text: noteAction(session, args) };
        const { marked } = replayMarks(session);
        const rows = candidates(session);
        if (args.action === 'list') return { text: JSON.stringify(rows.map(({ event, call }) => ({
          seq: event.seq, tool: call.data.name, callId: call.data.callId,
          ...(marked.has(event.seq) ? { reason: marked.get(event.seq) } : {}),
        }))) };
        if (args.action === 'release') {
          if (!args.seqs?.length || args.seqs.some(seq => !marked.has(seq))) throw new Error('请指定已有保留标注的事件号。');
          return { text: '已取消标注。对应结果将在下轮请求前参与代谢。' };
        }
        if (!['mark', 'settle'].includes(args.action)) throw new Error('未知的代谢操作。');
        const keep = args.keep ?? [];
        if (args.action === 'mark' && !keep.length) throw new Error('请提交至少一条保留标注。');
        const valid = new Set(rows.map(({ event }) => event.seq));
        for (const mark of keep) {
          if (!valid.delete(mark.seq) || !mark.reason.trim()) throw new Error('保留标注必须引用唯一的当前候选事件并写明理由。');
        }
        return { text: args.action === 'mark' ? '已添加保留标注，取消前持续有效。' : '已登记，当前轮正常结束后生效。' };
      },
    });
    registered.set(agent, dispose);
  }
  ctx.on('agent/created', ({ agent }) => register(agent));
  ctx.on('agent/disposed', ({ agent }) => registered.delete(agent));
  for (const agent of ctx.agents.list()) register(agent);

  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const session = agent.session;
    if (!inScope(agent)) return next();
    retireNotebookSnapshots(session, notebookText(session));
    if (step !== 1) return next();
    const current = turnStart(session);
    if (current?.data.turn !== turn) return next();
    const { turn: previous, marked } = replayMarks(session, current.seq);
    for (const { event } of candidates(session)) {
      const seq = event.seq;
      if (!(event.data.turn < turn) || marked.has(seq)) continue;
      const forceHistory = previous?.completed && previous.includeHistory && event.data.turn < previous.number;
      try {
        const original = session.deriveEventMessage(event);
        const content = text(`${prefix}${seq}]`);
        const previousTokens = ctx.tokenMeter.estimateMessage(original);
        const message = { ...original, content };
        if (!forceHistory && ctx.tokenMeter.estimateMessage(message) >= previousTokens) continue;
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: previousTokens,
        });
        session.append('tool/result', { ...event.data, message }, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
        });
      } catch (error) {
        ctx.logger.warn(`代谢替换事件 ${seq} 失败：${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    return next();
  });
}
