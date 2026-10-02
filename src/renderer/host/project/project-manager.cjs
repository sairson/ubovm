'use strict';

const { withCenteredProjectDialog } = require('./project-dialog.cjs');

function createProjectManager(vscode, sessions, actions) {
  let pending, closePicker, disposed = false;
  function choose(filter, activeId) {
    return withCenteredProjectDialog(vscode, () => new Promise((resolve, reject) => {
      const picker = vscode.window.createQuickPick();
      const subscriptions = [];
      let settled = false;
      const finish = (value, failure) => {
        if (settled) return;
        settled = true;
        closePicker = undefined;
        for (const subscription of subscriptions) {
          try { subscription.dispose(); } catch (error) { failure ||= error; }
        }
        try { picker.hide(); } catch (error) { failure ||= error; }
        try { picker.dispose(); } catch (error) { failure ||= error; }
        if (failure) reject(failure); else resolve(value);
      };
      const create = { iconPath: new vscode.ThemeIcon('new-folder'), tooltip: '新建项目' };
      const rename = { iconPath: new vscode.ThemeIcon('edit'), tooltip: '重命名项目' };
      const remove = { iconPath: new vscode.ThemeIcon('trash'), tooltip: '删除项目' };
      picker.title = '项目管理';
      picker.placeholder = '搜索项目名称或目录，选择项目打开';
      picker.matchOnDescription = picker.matchOnDetail = true;
      picker.buttons = [create];
      let fingerprint;
      const newProject = { label: '$(new-folder) 新建项目', detail: '输入名称和目录，自动创建文件夹并开始会话', action: 'create', alwaysShow: true };
      const refresh = () => {
        if (settled) return;
        const current = sessions.summary().projectId;
        const selectedItem = picker.activeItems?.[0];
        const selectedId = picker.activeItems?.[0]?.projectId || activeId || current;
        const projects = sessions.projects().map(project => {
          const members = sessions.projectSessions(project.id);
          const running = actions.runningCount?.(project.id) || 0;
          const folder = project.workspace?.split(/[\\/]/).filter(Boolean).pop() || project.workspace || '';
          return { label: project.name, description: `${project.id === current ? '当前项目 · ' : ''}${folder} · ${members.length} 个会话${running ? ` · ${running} 运行中` : ''}`,
            detail: project.workspace, projectId: project.id, buttons: running ? [rename] : [rename, remove] };
        });
        const nextFingerprint = JSON.stringify(projects.map(project => [project.projectId, project.label, project.description, project.detail, project.buttons.length]));
        if (fingerprint === nextFingerprint) return;
        fingerprint = nextFingerprint;
        picker.items = [newProject,
          ...(projects.length ? [{ label: '已保存项目', kind: vscode.QuickPickItemKind.Separator }, ...projects] : [])];
        const active = projects.find(project => project.projectId === selectedId);
        if (!picker.value) {
          if (selectedItem?.action === 'create') picker.activeItems = [newProject];
          else if (active) picker.activeItems = [active];
        }
      };
      subscriptions.push(picker.onDidAccept(() => {
        const item = picker.selectedItems[0];
        if (!item || item.kind === vscode.QuickPickItemKind.Separator) return;
        finish({ action: item.action || 'open', id: item.projectId, filter: picker.value });
      }));
      subscriptions.push(picker.onDidTriggerButton(button => { if (button === create) finish({ action: 'create', filter: picker.value }); }));
      subscriptions.push(picker.onDidTriggerItemButton(({ item, button }) => {
        if (!item.projectId || ![rename, remove].includes(button)) return;
        finish({ action: button === rename ? 'rename' : 'remove', id: item.projectId, filter: picker.value });
      }));
      subscriptions.push(picker.onDidHide(() => finish(undefined)));
      subscriptions.push(sessions.provider.onDidChangeTreeData(() => {
        try { refresh(); } catch (error) { finish(undefined, error); }
      }));
      closePicker = () => finish(undefined);
      picker.value = filter || '';
      try { refresh(); picker.show(); } catch (error) { finish(undefined, error); }
    }));
  }
  async function run() {
    let filter = '', activeId;
    while (!disposed) {
      const selected = await choose(filter, activeId);
      if (!selected) return;
      filter = selected.filter; activeId = selected.id;
      try {
        if (selected.action === 'create') { if (await actions.create(filter)) return; continue; }
        if (selected.action === 'open') { await actions.open(selected.id); return; }
        if (selected.action === 'rename') {
          await actions.rename(selected.id);
          const project = sessions.projects().find(project => project.id === selected.id);
          const terms = filter.toLocaleLowerCase().split(/\s+/).filter(Boolean);
          if (project && !terms.every(term => (project.name + ' ' + project.workspace).toLocaleLowerCase().includes(term))) filter = '';
        } else await actions.remove(selected.id);
      } catch (error) { if (!disposed) await actions.onError(error); }
    }
  }
  return { show() {
    if (disposed) return Promise.resolve();
    if (!pending) pending = run().finally(() => { pending = undefined; });
    return pending;
  }, dispose() { disposed = true; closePicker?.(); } };
}

module.exports = { createProjectManager };
