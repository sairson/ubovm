/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { BrowserActionCategory } from '../browserEditor.js';

let locked = false;
let reason = localize('browser.agentControl.defaultReason', "Agent 正在操作浏览器（只读）");
const onDidChange = new Emitter<void>();

export function isBrowserAgentControlLocked(): boolean {
	return locked;
}

export function getBrowserAgentControlReason(): string {
	return reason;
}

export function onDidChangeBrowserAgentControlLock(): Event<void> {
	return onDidChange.event;
}

export function setBrowserAgentControlLock(next: boolean, nextReason?: string): void {
	const message = typeof nextReason === 'string' && nextReason.trim()
		? nextReason.trim()
		: localize('browser.agentControl.defaultReason', "Agent 正在操作浏览器（只读）");
	if (locked === next && reason === message) {
		return;
	}
	locked = next;
	reason = message;
	onDidChange.fire();
}

class SetBrowserAgentControlLockAction extends Action2 {
	constructor() {
		super({
			id: BrowserViewCommandId.SetAgentControlLock,
			title: localize2('browser.setAgentControlLock', "Set Browser Agent Control Lock"),
			category: BrowserActionCategory,
			f1: false,
		});
	}

	run(_accessor: ServicesAccessor, lockedArg?: unknown, reasonArg?: unknown): void {
		setBrowserAgentControlLock(lockedArg === true, typeof reasonArg === 'string' ? reasonArg : undefined);
	}
}

registerAction2(SetBrowserAgentControlLockAction);
