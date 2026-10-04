(() => {
  'use strict';
  const stages = [['develop', '开发'], ['audit', '代码审计'], ['security', '安全测试'], ['deploy', '部署验证'], ['operate', '运维交接']];
  const severity = { critical: '严重', high: '高危', medium: '中危', low: '低危' };
  const text = value => typeof value === 'string' ? value : '';
  const tr = value => window.UBOVMi18n?.t(value) ?? value;
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
  function domainCoverage(inventory, record) {
    const acceptedCoverage = record?.acceptance?.security?.domainCoverage;
    if (acceptedCoverage && typeof acceptedCoverage === 'object') {
      return {
        seedRoots: Array.isArray(acceptedCoverage.seedRoots) ? acceptedCoverage.seedRoots : [],
        total: Number(acceptedCoverage.total) || 0,
        counts: acceptedCoverage.counts || {},
        incomplete: Array.isArray(acceptedCoverage.incomplete) ? acceptedCoverage.incomplete : [],
        coverageRate: Number(acceptedCoverage.coverageRate) || 0,
        complete: acceptedCoverage.complete === true
      };
    }
    if (!inventory || !Array.isArray(inventory.domains)) return null;
    const counts = { pending: 0, in_progress: 0, tested: 0, skipped: 0, out_of_scope: 0 };
    const incomplete = [];
    for (const item of inventory.domains) {
      const status = item?.test_status;
      if (counts[status] !== undefined) counts[status]++;
      if (status === 'pending' || status === 'in_progress') incomplete.push(item.hostname);
    }
    const total = inventory.domains.length;
    const closed = counts.tested + counts.skipped + counts.out_of_scope;
    return {
      seedRoots: Array.isArray(inventory.seedRoots) ? inventory.seedRoots : [],
      total,
      counts,
      incomplete,
      coverageRate: total ? closed / total : 0,
      complete: total > 0 && incomplete.length === 0
    };
  }
  window.createDeliveryView = root => {
    let currentRecord, currentInventory, session = '';
    const label = node('strong', '', tr('新项目交付')), status = node('span', 'delivery-status');
    const summary = node('summary', 'delivery-heading'); summary.append(label, status);
    const details = node('details', 'delivery-panel');
    const body = node('div', 'delivery-body');
    body.tabIndex = 0; body.setAttribute('aria-label', tr('新项目交付验收详情'));
    details.append(summary, body); root.append(details);
    root.hidden = true;
    return {
      update(record, sessionId, inventory) {
        if (sessionId !== session) { details.open = false; currentRecord = undefined; currentInventory = undefined; session = sessionId; }
        const visible = record?.projectType === 'new-development' && record.acceptance && Array.isArray(record.findings);
        root.hidden = !visible;
        if (!visible) { body.replaceChildren(); currentRecord = undefined; currentInventory = undefined; return; }
        if ((currentRecord === record || (currentRecord && Number.isSafeInteger(record.revision) && currentRecord.revision === record.revision))
          && currentInventory === inventory) return;
        currentRecord = record;
        currentInventory = inventory;
        const open = record.findings.filter(item => item.status === 'open');
        const blocking = open.filter(item => ['critical', 'high'].includes(item.severity));
        const passed = stages.filter(([stage]) => accepted(record, stage)).length;
        const coverage = domainCoverage(inventory, record);
        const coverageLabel = coverage
          ? (coverage.complete
            ? ` · 域名覆盖 ${coverage.total}/${coverage.total}`
            : ` · 域名待测 ${coverage.incomplete.length}/${coverage.total || 0}`)
          : '';
        status.textContent = `${passed}/5 已记录验收${blocking.length ? ` · ${blocking.length} 项发布阻塞` : passed === 5 ? ' · 交付验收已记录' : ''}${coverageLabel}`;
        const fragment = document.createDocumentFragment();
        fragment.append(node('p', 'delivery-objective', text(record.objective)), node('p', 'delivery-artifact', tr('当前版本 · ') + text(record.artifact)));
        if (coverage && (coverage.total || coverage.seedRoots.length)) {
          const section = node('section', 'delivery-domains');
          section.append(node('h3', '', tr('域名覆盖')));
          const rate = Math.round((coverage.coverageRate || 0) * 100);
          section.append(node('p', 'delivery-detail',
            coverage.complete
              ? `已完成 · ${coverage.total} 个主机 · 覆盖率 ${rate}%`
              : `未完成 · 待测 ${coverage.incomplete.length} · 共 ${coverage.total} · 覆盖率 ${rate}%`));
          if (coverage.seedRoots.length) section.append(node('p', 'delivery-detail', '种子域 · ' + coverage.seedRoots.slice(0, 12).join(', ')));
          if (coverage.incomplete.length) section.append(node('p', 'delivery-detail', '待测 · ' + coverage.incomplete.slice(0, 20).join(', ')));
          const counts = coverage.counts || {};
          section.append(node('p', 'delivery-detail',
            `已测 ${counts.tested || 0} · 跳过 ${counts.skipped || 0} · 范围外 ${counts.out_of_scope || 0} · 进行中 ${counts.in_progress || 0}`));
          fragment.append(section);
        }
        const timeline = node('ol', 'delivery-stages');
        for (const [stage, title] of stages) {
          const entry = record.acceptance[stage], blocked = record.blocked?.[stage];
          const done = accepted(record, stage);
          const state = done ? 'accepted' : blocked ? 'blocked' : 'pending';
          const item = node('li', 'delivery-stage'); item.dataset.status = state;
          item.append(node('strong', '', tr(title)), node('span', '', tr(done ? '已记录验收' : blocked ? '待解除阻塞' : entry ? '待补充验收' : '待验收')));
          timeline.append(item);
        }
        fragment.append(timeline);
        for (const [stage, title] of stages) {
          const entry = record.acceptance[stage], blocked = record.blocked?.[stage];
          if (!entry && !blocked) continue;
          const section = node('section', 'delivery-check');
          section.append(node('h3', '', tr(title)), node('p', '', text(entry?.summary ?? blocked?.summary)));
          for (const [key, caption] of [['scope', '测试范围'], ['endpoint', '上线地址'], ['vantage', '验证来源'], ['rollback', '回滚方式'], ['monitoring', '监控检查'], ['owner', '负责方']]) {
            const value = entry?.[key] ?? blocked?.[key];
            if (text(value)) section.append(node('p', 'delivery-detail', tr(caption) + ' · ' + value));
          }
          if (entry) section.append(node('small', '', `${entry.evidence?.length ?? 0} 条执行证据 · ${text(entry.artifact)}`));
          fragment.append(section);
        }
        if (open.length) {
          const section = node('section', 'delivery-findings'); section.append(node('h3', '', `未关闭问题 · ${open.length}`));
          for (const finding of open.slice(0, 50)) {
            const item = node('p', 'delivery-finding'); item.dataset.severity = finding.severity;
            item.append(node('strong', '', `${tr(severity[finding.severity] ?? '风险')} · ${text(finding.id)}`), node('span', '', text(finding.summary)));
            section.append(item);
          }
          if (open.length > 50) section.append(node('p', 'delivery-detail', tr('更多问题请通过交付记录工具查看。')));
          fragment.append(section);
        }
        fragment.append(node('p', 'delivery-caption', tr('阶段验收由 Agent 根据执行证据记录；安全阶段需域名台账覆盖完整。单项任务可独立运行。')));
        const scrollTop = body.scrollTop;
        body.replaceChildren(fragment);
        body.scrollTop = scrollTop;
      }
    };
  };
})();
