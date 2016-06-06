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
		action: () => GDB.continue_()
	},
	"next": {
		cmd: "next",
		icon: "arrow-right",
		title: "Next",
		action: () => GDB.next()
	},
	"step-in": {
		cmd: "step-in",
		icon: "arrow-down",
		title: "Step In",
		action: () => GDB.stepIn()
	},
	"step-out": {
		cmd: "step-out",
		icon: "arrow-up",
		title: "Step Out",
		action: () => GDB.stepOut()
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
["run-tests", "run-package", "continue", "next", "step-in", "step-out", "restart", "stop", "toggle-breakpoint"]
	.forEach((cmd) => keyboardCommands["gdb-debug:" + cmd] = commands[cmd].action);

const panelCommandsNotReady = [
	commands["run-tests"],
	commands["run-package"]
];
const panelCommandsReady = [
	commands.continue,
	commands.next,
	commands["step-in"],
	commands["step-out"],
	commands.restart,
	commands.stop
];

export const getPanelCommands = () => GDB.isStarted() ? panelCommandsReady : panelCommandsNotReady;

export const get = (cmd) => commands[cmd];

export const getKeyboardCommands = () => keyboardCommands;
