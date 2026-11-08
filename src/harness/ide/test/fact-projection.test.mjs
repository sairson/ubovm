import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FACT_CONTENT_LIMIT, projectFactContent } = require('../runtime/fact-projection.cjs');

const coverageItem = index => ({
  point: `检查项 ${index}：配置文件中存在超时设置并且覆盖了默认值`.repeat(8),
  result: `已读取并确认第 ${index} 项与运行时环境一致，包含边界条件`.repeat(8),
  status: ['confirmed', 'partial', 'negative', 'blocked'][index % 4]
});
const evidenceItem = index => ({
  observation: `第 ${index} 次读取配置文件得到 timeout=${index}，与上一次运行结果一致`.repeat(8),
  toolCallId: `call-${index}`
});
const envelope = (overrides = {}) => ({
  version: 1,
  outcome: 'partial',
  statement: '已确认配置文件中存在超时设置，但尚未验证运行时行为；需要继续检查边界条件。'.repeat(120),
  coverage: Array.from({ length: 20 }, (_, index) => coverageItem(index)),
  evidence: Array.from({ length: 20 }, (_, index) => evidenceItem(index)),
  failedChecks: Array.from({ length: 8 }, (_, index) => `失败检查 ${index}：运行时超时未触发`),
  limitations: Array.from({ length: 8 }, (_, index) => `限制 ${index}：未覆盖并发场景`),
  nextSteps: Array.from({ length: 8 }, (_, index) => `后续 ${index}：执行并发压力测试`),
  ...overrides
});

test('short and plain fact bodies are projected verbatim', () => {
  assert.deepEqual(projectFactContent('普通事实。\n第二行。'), { content: '普通事实。\n第二行。', clipped: false });
  assert.deepEqual(projectFactContent(undefined), { content: '', clipped: false });
  const small = JSON.stringify({ version: 1, statement: '短结论', evidence: [], coverage: [] });
  assert.deepEqual(projectFactContent(small), { content: small, clipped: false });
});

test('oversized Worker envelopes become a smaller valid envelope with omission counts', () => {
  const source = JSON.stringify(envelope());
  assert.ok(source.length > FACT_CONTENT_LIMIT);
  const projected = projectFactContent(source);
  assert.equal(projected.clipped, true);
  assert.ok(projected.content.length <= FACT_CONTENT_LIMIT, `projected ${projected.content.length} chars`);
  const fact = JSON.parse(projected.content);
  assert.equal(fact.version, 1);
  assert.equal(fact.outcome, 'partial');
  assert.ok(fact.statement.startsWith('已确认配置文件中存在超时设置'));
  assert.equal(fact.truncated, true);
  assert.ok(Array.isArray(fact.evidence) && Array.isArray(fact.coverage));
  assert.ok(fact.coverage.length > 0 && fact.coverage.length <= 10);
  assert.ok(fact.omitted.coverage > 0, 'omitted coverage is counted');
  assert.ok(fact.omitted.evidence > 0, 'omitted evidence is counted');
  assert.ok(fact.evidence.every(item => typeof item.observation === 'string'));
});

test('an oversized envelope without an evidence array still becomes structured JSON', () => {
  const source = JSON.stringify({ version: 1, statement: '结论'.repeat(7000), coverage: [], limitations: ['限制'] });
  assert.ok(source.length > FACT_CONTENT_LIMIT);
  const projected = projectFactContent(source);
  const fact = JSON.parse(projected.content);
  assert.equal(fact.version, 1);
  assert.ok(Array.isArray(fact.evidence));
  assert.deepEqual(fact.evidence, []);
  assert.equal(fact.truncated, true);
});

test('a pathological single-paragraph statement still yields valid bounded JSON', () => {
  const source = JSON.stringify(envelope({
    statement: '结论片段'.repeat(6000),
    coverage: [], evidence: [], failedChecks: [], limitations: [], nextSteps: []
  }));
  const projected = projectFactContent(source);
  assert.equal(projected.clipped, true);
  assert.ok(projected.content.length <= FACT_CONTENT_LIMIT);
  const fact = JSON.parse(projected.content);
  assert.equal(fact.version, 1);
  assert.ok(fact.truncated);
  assert.ok(fact.statement.length > 0);
});

test('long plain text and non-envelope JSON are clipped without pretending to be structured', () => {
  const plain = '普通事实内容'.repeat(4000);
  const projectedPlain = projectFactContent(plain);
  assert.equal(projectedPlain.clipped, true);
  assert.equal(projectedPlain.content.length, FACT_CONTENT_LIMIT);
  assert.equal(projectedPlain.content, plain.slice(0, FACT_CONTENT_LIMIT));

  const other = JSON.stringify({ version: 2, statement: 'x'.repeat(20000), evidence: [] });
  const projectedOther = projectFactContent(other);
  assert.equal(projectedOther.clipped, true);
  assert.equal(projectedOther.content, other.slice(0, FACT_CONTENT_LIMIT));
});
