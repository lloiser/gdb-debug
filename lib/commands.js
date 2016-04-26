"use babel";

import * as GDB from "./gdb";
import { store } from "./store";

function currentFile() {
	const editor = atom.workspace.getActiveTextEditor();
	return editor && editor.getPath();
}

function currentLine() {
	const editor = atom.workspace.getActiveTextEditor();
	return editor && editor.getCursorBufferPosition().row;
}

const commands = {
	"run-tests": {
		cmd: "run-tests",
		text: "Test",
		title: "Run package test",
		action: () => GDB.runTests(currentFile())
	},
	"run-package": {
		cmd: "run-package",
		text: "Debug",
		title: "Debug package",
		action: () => GDB.runPackage(currentFile())
	},
	"continue": {
		cmd: "continue",
		icon: "triangle-right",
		title: "Continue",
		action: () => GDB.command("continue")
	},
	"next": {
		cmd: "next",
		icon: "arrow-right",
		title: "Next",
		action: () => GDB.command("next")
	},
	"step": {
		cmd: "step",
		icon: "arrow-down",
		title: "Step",
		action: () => GDB.command("step")
	},
	"restart": {
		cmd: "restart",
		icon: "sync",
		title: "Restart",
		action: () => GDB.restart()
	},
	"stop": {
		cmd: "stop",
		icon: "primitive-square",
		title: "Stop",
		action: () => GDB.stop()
	},
	"toggle-breakpoint": {
		action: () => GDB.toggleBreakpoint(currentFile(), currentLine())
	},
	"toggle-panel": {
		action: () => store.dispatch({ type: "TOGGLE_PANEL" })
	}
};

const keyboardCommands = {};
["run-tests", "run-package", "continue", "next", "step", "restart", "stop", "toggle-breakpoint"]
	.forEach((cmd) => keyboardCommands["gdb-debug:" + cmd] = commands[cmd].action);

const panelCommandsNotReady = [
	commands["run-tests"],
	commands["run-package"]
];
const panelCommandsReady = [
	commands.continue,
	commands.next,
	commands.step,
	commands.restart,
	commands.stop
];

export const getPanelCommands = () => GDB.isStarted() ? panelCommandsReady : panelCommandsNotReady;

export const get = (cmd) => commands[cmd];

export const getKeyboardCommands = () => keyboardCommands;
