(() => {
  'use strict';
  const stages = [['develop', '开发'], ['audit', '代码审计'], ['security', '安全测试'], ['deploy', '部署验证'], ['operate', '运维交接']];
  const severity = { critical: '严重', high: '高危', medium: '中危', low: '低危' };
  const text = value => typeof value === 'string' ? value : '';
  const node = (tag, className, value) => {
    const element = document.createElement(tag); element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  };
  function accepted(record, stage) {
    const item = record.acceptance?.[stage];
    if (!item || !text(item.summary) || !Array.isArray(item.evidence) || !item.evidence.length) return false;
    if (stage === 'security' && !text(item.scope)) return false;
    if (stage === 'deploy' && (!text(item.endpoint) || !text(item.vantage))) return false;
    if (stage === 'operate' && ['rollback', 'monitoring', 'owner'].some(key => !text(item[key]))) return false;
    return true;
  }
  window.createDeliveryView = root => {
    let currentRecord, session = '';
    const label = node('strong', '', '新项目交付'), status = node('span', 'delivery-status');
    const summary = node('summary', 'delivery-heading'); summary.append(label, status);
    const details = node('details', 'delivery-panel');
    const body = node('div', 'delivery-body');
    body.tabIndex = 0; body.setAttribute('aria-label', '新项目交付验收详情');
    details.append(summary, body); root.append(details);
    root.hidden = true;
    return {
      update(record, sessionId) {
        if (sessionId !== session) { details.open = false; currentRecord = undefined; session = sessionId; }
        const visible = record?.projectType === 'new-development' && record.acceptance && Array.isArray(record.findings);
        root.hidden = !visible;
        if (!visible) { body.replaceChildren(); currentRecord = undefined; return; }
        if (currentRecord === record || currentRecord && Number.isSafeInteger(record.revision) && currentRecord.revision === record.revision) return;
        currentRecord = record;
        const open = record.findings.filter(item => item.status === 'open');
        const blocking = open.filter(item => ['critical', 'high'].includes(item.severity));
        const passed = stages.filter(([stage]) => accepted(record, stage)).length;
        status.textContent = `${passed}/5 已记录验收${blocking.length ? ` · ${blocking.length} 项发布阻塞` : passed === 5 ? ' · 交付验收已记录' : ''}`;
        const fragment = document.createDocumentFragment();
        fragment.append(node('p', 'delivery-objective', text(record.objective)), node('p', 'delivery-artifact', '当前版本 · ' + text(record.artifact)));
        const timeline = node('ol', 'delivery-stages');
        for (const [stage, title] of stages) {
          const entry = record.acceptance[stage], blocked = record.blocked?.[stage];
          const done = accepted(record, stage);
          const state = done ? 'accepted' : blocked ? 'blocked' : 'pending';
          const item = node('li', 'delivery-stage'); item.dataset.status = state;
          item.append(node('strong', '', title), node('span', '', done ? '已记录验收' : blocked ? '待解除阻塞' : entry ? '待补充验收' : '待验收'));
          timeline.append(item);
        }
        fragment.append(timeline);
        for (const [stage, title] of stages) {
          const entry = record.acceptance[stage], blocked = record.blocked?.[stage];
          if (!entry && !blocked) continue;
          const section = node('section', 'delivery-check');
          section.append(node('h3', '', title), node('p', '', text(entry?.summary ?? blocked?.summary)));
          for (const [key, caption] of [['scope', '测试范围'], ['endpoint', '上线地址'], ['vantage', '验证来源'], ['rollback', '回滚方式'], ['monitoring', '监控检查'], ['owner', '负责方']]) {
            const value = entry?.[key] ?? blocked?.[key];
            if (text(value)) section.append(node('p', 'delivery-detail', caption + ' · ' + value));
          }
          if (entry) section.append(node('small', '', `${entry.evidence?.length ?? 0} 条执行证据 · ${text(entry.artifact)}`));
          fragment.append(section);
        }
        if (open.length) {
          const section = node('section', 'delivery-findings'); section.append(node('h3', '', `未关闭问题 · ${open.length}`));
          for (const finding of open.slice(0, 50)) {
            const item = node('p', 'delivery-finding'); item.dataset.severity = finding.severity;
            item.append(node('strong', '', `${severity[finding.severity] ?? '风险'} · ${text(finding.id)}`), node('span', '', text(finding.summary)));
            section.append(item);
          }
          if (open.length > 50) section.append(node('p', 'delivery-detail', '更多问题请通过交付记录工具查看。'));
          fragment.append(section);
        }
        fragment.append(node('p', 'delivery-caption', '阶段验收由 Agent 根据执行证据记录；单项任务可独立运行。模型与 SSH 是所有任务的基础配置。'));
        const scrollTop = body.scrollTop;
        body.replaceChildren(fragment);
        body.scrollTop = scrollTop;
      }
    };
  };
})();
