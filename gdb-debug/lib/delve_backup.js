"use babel";

import { spawn } from "child_process";
import rpc from "json-rpc2";
import * as path from "path";
import { store, getBreakpoint, getBreakpoints } from "./store";

const SERVER_URL = "localhost";
const SERVER_PORT = 2345;
const RPC_ENDPOINT = "RPCServer.";

let dlvProcess;
let dlvConnection;

export function runTests(file) {
	return run(file, "test");
}

export function runPackage(file) {
	return run(file, "debug");
}

function addOutputMessage(messageType, message, args) {
	store.dispatch({ type: "ADD_OUTPUT_MESSAGE", messageType, message, args });
}

function run(file, method) {
	const { path: dlvPath, args } = store.getState().delve;
	if (!dlvPath || dlvProcess || !file) {
		return;
	}
	store.dispatch({ type: "SET_STATE", state: "starting" });

	let dlvArgs = [method, "--headless=true", `--listen=${SERVER_URL}:${SERVER_PORT}`, "--log"];
	if (args && method !== "test") {
		dlvArgs = dlvArgs.concat("--", splitArgs(args));
	}

	addOutputMessage("go-debug", `Starting delve with "${file}" with "${method}"`);
	dlvProcess = spawn(dlvPath, dlvArgs, {
		cwd: path.dirname(file)
	});

	let rpcClient;
	dlvProcess.stderr.on("data", (chunk) => {
		addOutputMessage("go-debug", "Delve output: " + chunk.toString());
		if (!rpcClient) {
			rpcClient = rpc.Client.$create(SERVER_PORT, SERVER_URL);
			rpcClient.connectSocket((err, conn) => {
				if (err) {
					addOutputMessage("go-debug", `Failed to start delve\n\terror: ${err}`);

					stop();
					return;
				}
				dlvConnection = conn;
				addOutputMessage("go-debug", `Started delve with "${file}" with "${method}"`);
				store.dispatch({ type: "SET_STATE", state: "started" });

				getBreakpoints().forEach((bp) => {
					addBreakpoint(bp.file, bp.line);
				});
			});
		}
	});

	dlvProcess.stdout.on("data", (chunk) => {
		addOutputMessage("output", chunk.toString());
	});

	dlvProcess.on("close", (code) => {
		addOutputMessage("go-debug", "delve closed with code " + code);
		stop();
	});
	dlvProcess.on("error", (err) => {
		addOutputMessage("go-debug", "error: " + err);
		stop();
	});
}

export function stop() {
	if (dlvConnection) {
		dlvConnection.end();
	}
	dlvConnection = null;

	if (dlvProcess) {
		dlvProcess.kill();
	}
	dlvProcess = null;

	store.dispatch({ type: "STOP" });
}

export function addBreakpoint(file, line) {
	if (!isStarted()) {
		store.dispatch({ type: "ADD_BREAKPOINT", bp: { file, line, state: "notStarted" } });
		return Promise.resolve();
	}

	const bp = getBreakpoint(file, line);
	if (bp && bp.state === "busy") {
		return Promise.resolve();
	}

	// note: delve requires 1 indexed line numbers whereas atom has 0 indexed
	const fileAndLine = `${file}:${line + 1}`;
	addOutputMessage("go-debug", `Adding breakpoint: ${fileAndLine}`);
	store.dispatch({ type: "ADD_BREAKPOINT", bp: { file, line } });
	return _addBreakpoint(file, line + 1)
	.then((response) => {
		addOutputMessage("go-debug", `Added breakpoint: ${fileAndLine}`);
		store.dispatch({ type: "ADD_BREAKPOINT", bp: { file, line, id: response.id, state: "valid" } });
	})
	.catch((err) => {
		addOutputMessage("go-debug", `Adding breakpoint failed: ${fileAndLine}\n\terror: ${err}`);
		store.dispatch({ type: "ADD_BREAKPOINT", bp: { file, line, state: "invalid", message: err } });
	});
}
function _addBreakpoint(file, line) {
	return call("CreateBreakpoint", { file, line });
}

export function removeBreakpoint(file, line) {
	const bp = getBreakpoint(file, line);
	if (!bp) {
		return Promise.resolve();
	}

	function done() {
		store.dispatch({ type: "REMOVE_BREAKPOINT", bp: { file, line, state: "removed" } });
	}

	if (bp.state === "invalid" || !isStarted()) {
		return Promise.resolve().then(done);
	}

	const fileAndLine = `${file}:${line + 1}`;
	addOutputMessage("go-debug", `Removing breakpoint: ${fileAndLine}`);
	store.dispatch({ type: "REMOVE_BREAKPOINT", bp: { file, line, state: "busy" } });
	return _removeBreakpoint(bp.id)
	.then(() => addOutputMessage("go-debug", `Removed breakpoint: ${fileAndLine}`))
	.then(done);
}
function _removeBreakpoint(id) {
	return call("ClearBreakpoint", id);
}

export function toggleBreakpoint(file, line) {
	const bp = getBreakpoint(file, line);
	if (!bp) {
		return addBreakpoint(file, line);
	}
	return removeBreakpoint(file, line);
}

export function updateBreakpointLine(file, line, newLine) {
	const bp = getBreakpoint(file, line);
	if (!isStarted()) {
		// just update the breakpoint in the store
		store.dispatch({ type: "UPDATE_BREAKPOINT_LINE", bp, newLine });
		return;
	}

	// remove and add the breakpoint, this also updates the store correctly
	_removeBreakpoint(bp.id).then(() => _addBreakpoint(file, newLine));
}

// command executes the given command (like continue, step, next, ...)
export function command(name) {
	if (!isStarted()) {
		return;
	}
	addOutputMessage("go-debug", `Executing command ${name}`);
	store.dispatch({ type: "SET_STATE", state: "busy" });
	call("Command", { name }).then((newState) => {
		if (newState.exited) {
			stop();
			return;
		}

		store.dispatch({ type: "SET_STATE", state: "waiting" });

		selectGoroutine(newState.currentGoroutine.id);
		selectStacktrace(0);

		getGoroutines();
	});
}

// restart the delve session
export function restart() {
	if (!isStarted()) {
		return;
	}
	call("Restart", []).then(() => {
		store.dispatch({ type: "RESTART" });
	});
}

function getStacktrace() {
	if (!isStarted()) {
		return;
	}
	const args = {
		id: store.getState().delve.selectedGoroutine,
		depth: 20,
		full: true
	};
	call("StacktraceGoroutine", args).then((stacktrace) => {
		store.dispatch({ type: "UPDATE_STACKTRACE", stacktrace });
	});
}

function getGoroutines() {
	if (!isStarted()) {
		return;
	}
	call("ListGoroutines").then((goroutines) => {
		store.dispatch({ type: "UPDATE_GOROUTINES", goroutines });
	});
}

export function selectStacktrace(index) {
	store.dispatch({ type: "SET_SELECTED_STACKTRACE", index });
}

export function selectGoroutine(id) {
	if (!isStarted()) {
		return;
	}
	if (store.getState().delve.selectedGoroutine === id) {
		getStacktrace();
		return; // no need to change
	}
	store.dispatch({ type: "SET_SELECTED_GOROUTINE", state: "busy", id });
	call("Command", { name: "switchGoroutine", goroutineID: id }).then(() => {
		store.dispatch({ type: "SET_SELECTED_GOROUTINE", state: "waiting", id });
		getStacktrace();
	});
}

// call is the base method for all calls to delve
function call(method, ...args) {
	return new Promise((resolve, reject) => {
		const endpoint = RPC_ENDPOINT + method;
		dlvConnection.call(endpoint, args, (err, result) => {
			if (err) {
				addOutputMessage("go-debug", `Failed to call ${method}\n\terror: ${err}`);
				reject(err);
				return;
			}
			resolve(result);
		});
	});
}

export function isStarted() {
	const state = store.getState().delve.state;
	return state !== "notStarted" && state !== "starting";
}

// thanks to "yargs-parser" for this simple arguments parser!
function splitArgs(argString) {
	let i = 0;
	let c = null;
	let opening = null;
	const args = [];

	for (let j = 0; j < argString.length; j++) {
		c = argString.charAt(j);

		// split on spaces unless we're in quotes.
		if (c === " " && !opening) {
			i++;
			continue;
		}

		// don't split the string if we're in matching
		// opening or closing single and double quotes.
		if (c === opening) {
			opening = null;
			continue;
		} else if ((c === "'" || c === "\"") && !opening) {
			opening = c;
			continue;
		}

		if (!args[i]) {
			args[i] = "";
		}
		args[i] += c;
	}

	return args;
}
