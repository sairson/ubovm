import test from 'node:test';
import assert from 'node:assert/strict';
import { SECURITY_REVIEW_POLICY, isSecurityTask, securityPolicyFor } from '../security-policy.mjs';
import { reasonSystemPrompt } from '../agents/prompts.mjs';
import { workerSystemPrompt } from '../worker-agents/prompts.mjs';

test('security tasks are detected in Chinese and English without matching ordinary work', () => {
  for (const value of ['对授权目标做渗透测试', '代码审计：用户登录模块', 'verify this CVE-2024-0001', 'security audit of the API', 'CTF web challenge', 'threat model review']) {
    assert.equal(isSecurityTask(value), true, value);
    assert.match(securityPolicyFor(value), /authorized target/);
  }
  for (const value of ['优化登录页样式', 'refactor the billing service', 'write unit tests', 'update documentation', undefined, '']) {
    assert.equal(isSecurityTask(value), false, String(value));
    assert.equal(securityPolicyFor(value), '');
  }
});

test('Reason receives security evidence rules only for security goals', () => {
  const secure = reasonSystemPrompt({ goal: '对授权目标做代码审计并验证漏洞', maxIntents: 2, openIntents: 4, nodes: [] });
  assert.match(secure, /Security review tasks/);
  assert.match(secure, /authorized target and scope/);
  assert.match(secure, /file:line/);
  assert.match(secure, /confirmed only after executing a\s+runnable reproduction/);
  assert.match(secure, /Pentest evidence gate/);
  assert.match(secure, /note\` scope ledger/);
  assert.match(secure, /Flag ledger/);
  assert.match(secure, /never present it as a real vulnerability/);
  assert.ok(secure.includes(SECURITY_REVIEW_POLICY));
  const ordinary = reasonSystemPrompt({ goal: '优化登录页样式', maxIntents: 2, openIntents: 4, nodes: [] });
  assert.doesNotMatch(ordinary, /Security review tasks/);
});

test('Workers receive the same security rules through their host instructions', () => {
  const prompt = workerSystemPrompt('plan', securityPolicyFor('代码审计：检查授权管理'));
  assert.match(prompt, /Security review tasks/);
  assert.match(prompt, /reproducible evidence/);
  const ordinary = workerSystemPrompt('plan', '');
  assert.doesNotMatch(ordinary, /Security review tasks/);
});
