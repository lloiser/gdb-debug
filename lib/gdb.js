"use babel";

// TODO: add the token back to the executeAndWait (useful for the variables?)

import { spawn, exec } from "child_process";
import * as path from "path";
import { store, getBreakpoint, getBreakpoints } from "./store";

let gdbProcess;
let isRunning = false;

let variablesCache;

// TODO: add to store
let thread = 1;

export function runTests(file) {
	return buildAndRun(file);
}

export function runPackage(file) {
	return buildAndRun(file);
}

function addOutputMessage(messageType, message, args) {
	store.dispatch({ type: "ADD_OUTPUT_MESSAGE", messageType, message, args });
}

function buildAndRun(file) {
	if (gdbProcess) {
		return;
	}

	variablesCache = {};

	// TODO: the rebuild is not necessary here!
	const cwd = path.dirname(file);
	const outFile = "out";
	const files = "*" + path.extname(file);
	exec(`g++ -g ${files} -o ${outFile}`, { cwd }, (error, stdout, stderr) => {
		if (error) {
			console.error(error, stdout.toString(), stderr.toString());
			return;
		}

		addOutputMessage("gdb-debug", `Starting gdb with "${file}"`);

		runGdb(outFile, { gdbOptions: { cwd }});
	});
}



/**
 * runGdb - Initialize a debugging process using a compiled executable.
 *
 * Usage:
 *     runGdb("/path/to/outFile");
 *     runGdb("/path/to/outFile", {gdbCommand: '/path/to/toolchain/bin/gdb'});
 *     runGdb({gdbCommand: '/path/to/toolchain/bin/gdb'
 *             gdbArguments: ["/path/to/outFile", "--arg2=value2"]});
 *
 * @param {String} outFile      A path to an executable to debug. Ignored when `gdbArguments` is specified.
 * @param {String} gdbCommand   A path to the gdb executable. Optional. Default: `"gdb"`.
 * @param {String} gdbArguments Arguments to use when spawning the gdb process. Optional. Default: `[outFile, "--interpreter=mi2"]`.
 * @param {String} gdbOptions   Options to use when spawning the gdb process. Optional.
 */
export function runGdb(outFile, params = {}) {
	if (gdbProcess) {
		return;
	}

	if (typeof outFile !== "string") {
		params = outFile;
	}
	const gdbCommand   = typeof params.gdbCommand   !== "undefined" ? params.gdbCommand   : "gdb";
	const gdbArguments = typeof params.gdbArguments !== "undefined" ? params.gdbArguments : [outFile, "--interpreter=mi2"];
	const gdbOptions   = typeof params.gdbOptions   !== "undefined" ? params.gdbOptions   : {};

	const panelState = store.getState().panel;
	if (!panelState.visible) {
		store.dispatch({ type: "TOGGLE_PANEL" });
	}

	isRunning = false;
	gdbProcess = spawn(gdbCommand, gdbArguments, gdbOptions);

	wait().then(() => {
		store.dispatch({ type: "SET_STATE", state: "started" });

		getBreakpoints().forEach((bp) => {
			addBreakpoint(bp.file, bp.line);
		});
	});

	gdbProcess.stderr.on("data", (chunk) => {
		console.error(">>>>", chunk.toString());
	});

	gdbProcess.on("close", (code) => {
		console.log(">>>>", "gdb closed with code", code);
		stop();
	});
	gdbProcess.on("error", (err) => {
		console.error(">>>>", "gdb error", err);
		stop();
	});
}

export function stop() {
	if (gdbProcess) {
		gdbProcess.kill();
	}
	gdbProcess = null;

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

	// note: gdb requires 1 indexed line numbers whereas atom has 0 indexed
	const fileAndLine = `${file}:${line + 1}`;
	addOutputMessage("gdb-debug", `Adding breakpoint: ${fileAndLine}`);
	store.dispatch({ type: "ADD_BREAKPOINT", bp: { file, line } });
	return _addBreakpoint(file, line + 1).then((bp) => {
		if (bp) {
			addOutputMessage("gdb-debug", `Added breakpoint: ${fileAndLine}`);
			store.dispatch({ type: "ADD_BREAKPOINT", bp: { file, line, id: bp.number, state: "valid" } });
		}
	});
}
function _addBreakpoint(file, line) {
	return executeAndWait(`-break-insert ${file}:${line}`).then((results) => {
		let bp;
		results.forEach((result) => {
			if (result.type === "done" && result.value.bkpt) {
				bp = result.value.bkpt;
			}
		});
		return bp;
	});
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
	addOutputMessage("gdb-debug", `Removing breakpoint: ${fileAndLine}`);
	store.dispatch({ type: "REMOVE_BREAKPOINT", bp: { file, line, state: "busy" } });
	return _removeBreakpoint(bp.id)
		.then((success) => {
			if (success) {
				addOutputMessage("gdb-debug", `Removed breakpoint: ${fileAndLine}`);
				done();
			}
		});
}

function _removeBreakpoint(id) {
	return executeAndWait(`-break-delete ${id}`);
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

export function continue_() {
	if (!isRunning) {
		// we have to run the program first
		isRunning = true;
		return command("-exec-run").catch((err) => {
			const noRun = "The \"remote\" target does not support \"run\".";
			if (err && err.msg && err.msg.startsWith(noRun)) {
				// try continue instead
				return command("-exec-continue");
			}
			return err;
		});
	}

	// continue until the next breakpoint is hit
	return command("-exec-continue");
}
export function next() {
	// continue to the next line
	return command("-exec-next");
}
export function stepIn() {
	// continue to the next line AND step into functions
	return command("-exec-step");
}
export function stepOut() {
	return command("-exec-finish");
}

// command executes the given command (like continue, step, next, ...)
function command(cmd) {
	store.dispatch({ type: "SET_STATE", state: "busy" });

	const done = (results) => {
		const last = results[results.length-1];
		if (last.type === "running") {
			// still running - continue waiting
			return wait().then(done);
		}

		if (last.type === "stopped" && last.value.reason === "exited-normally") {
			stop();
			return Promise.resolve();
		}

		if (last.type === "error") {
			return Promise.reject(last.value);
		}

		// TODO: get all threads and display them in the panel

		const currentThread = last.value["thread-id"];
		if (currentThread) {
			thread = +currentThread;
		}

		store.dispatch({ type: "SET_STATE", state: "waiting" });

		return selectStacktrace(0).then(getStacktrace);
	};
	return executeAndWait(cmd).then(done);
}

// restart the gdb session
export function restart() {
	// throw "'restart' not implemented";
	/* if (!isStarted()) {
		return;
	}
	executeAndWait("r", "Start it from the beginning? (y or n)").then(() => {
		executeAndWait("y").then(() => store.dispatch({ type: "RESTART" }));
	}); */
}

function pathJoin(...items) {
	return items.filter((i) => i).join(".");
}

function createVariable(v) {
	const hasChildren = v.numchild !== "0";
	return {
		name: v.exp || v.name,
		loaded: hasChildren === false ? true : false, // TODO ???
		hasChildren,
		value: hasChildren ? v.type : v.value
	};
}

function getVariables(cmd, prop) {
	const { selectedStacktrace } = store.getState().gdb;
	// TODO: --simple-values   vs   --all-values
	return executeAndWait(cmd + ` --thread ${thread} --frame ${selectedStacktrace} --all-values`).then((results) => {
		return results.reduce((o, r) => {
			if (!o && r.type === "done" && r.value[prop]) {
				return r.value[prop];
			}
			return o;
		}, null);
	});
}

function registerVariables() {
	/* note: both commands returns the same as -stack-list-variables below
	return getVariables("-stack-list-locals", "locals").then((locals) => {
		return getVariables("-stack-list-arguments", "args").then((args) => {
			return (locals || []).concat(args || []);
		});
	}) */
	return getVariables("-stack-list-variables", "variables")
		.then((vars) => {
			const variables = {};
			const process = () => {
				const v = vars.shift();
				if (!v) {
					return Promise.resolve(variables); // done
				}
				if (variablesCache[v.name]) {
					// already registered - only update the variable
					return updateVariable(v.name, variables).then(process);
				}

				// register a new variable
				const frame = "@"; // TODO: @ = frame? see http://gdb.sourceware.narkive.com/2dXFnOyc/gdb-mi-var-update-create-bug
				return executeAndWait(`-var-create ${v.name} ${frame} ${v.name}`)
					.then((results) => {
						results.forEach(({ type, value }) => {
							if (type === "done") {
								variablesCache[value.name] = true;
								variables[value.name] = createVariable(value);
							}
						});
					})
					.then(process);
			};
			return process();
		}).then((variables) => {
			// update the variables cache
			Object.keys(variables).forEach((key) => {
				variablesCache[key] = variables[key];
			});
			return variables;
		}).then(ensureVariablesLoaded);
}

function updateVariable(path, variables) {
	// get the existing variables so that an already registered variable (in gdb) can be updated and returned
	return executeAndWait(`-var-update --simple-values ${path}`).then((results) => {
		// copy the existing variable and its children
		variables[path] = Object.assign({}, variablesCache[path]);
		Object.keys(variablesCache).forEach((p) => {
			if (p.startsWith(path + ".")) {
				variables[p] = variablesCache[p];
			}
		});

		// traverse the complete change model
		results.forEach(({ type, value }) => {
			if (type === "done") {
				const changelist = value.changelist;
				changelist.forEach((ch) => {
					const path = ch.name;
					const cachedVariable = variablesCache[path];
					let newVariable = {};
					if (ch.type_changed === "false") {
						// no type change -> update the value
						newVariable = {
							value: ch.value
						};
					} else {
						// type has changed! create a "new variable"
						const hasChildren =  ch.new_num_children !== "0";
						newVariable = {
							name: path.split(".").pop(),
							loaded: hasChildren === false ? true : false, // TODO ???
							hasChildren,
							value: hasChildren ? ch.new_type : ch.value
						};

						// remove all existing children because the type has changed and
						// the children are most likely not valid anymore
						Object.keys(variablesCache).forEach((p) => {
							if (p.startsWith(path + ".")) {
								variables[p] = null;
							}
						});
					}
					variables[path] = Object.assign({}, cachedVariable, newVariable);
				});
			}
		});
		return variables;
	});
}

/* function unregisterVariables() {
	const { variables } = (getCurrentStack() || {});
	if (!variables) {
		return Promise.resolve();
	}

	const paths = Object.keys(variables).filter((p) => p.indexOf(".") === -1);
	const process = () => {
		const path = paths.pop();
		if (!path) {
			return Promise.resolve();
		}
		return executeAndWait(`-var-delete ${variables[path].name}`).then((results) => {
			if (results[0].type !== "done") {
				console.log(path, results);
			}
		}).then(process);
	};
	return process();
} */

export function loadVariable(path) {
	return _loadVariable(path).then((variables) => {
		store.dispatch({
			// TODO: pass on which variable has been loaded (always parent path?)
			type: "UPDATE_VARIABLES",
			path,
			variables,
			index: store.getState().gdb.selectedStacktrace
		});

		return variables;
	});
}
function _loadVariable(path) {
	return executeAndWait(`-var-list-children --simple-values ${path}`).then((results) => {
		const variables = {};
		results.forEach(({ type, value }) => {
			if (type !== "done") {
				return;
			}
			value.children.forEach((v) => {
				const p = pathJoin(path, v.exp);
				variables[p] = createVariable(v);
			});
		}, null);

		// update the variables cache
		Object.keys(variables).forEach((key) => {
			variablesCache[key] = variables[key];
		});

		// TODO: load again?

		return variables;
	});
}
function ensureVariablesLoaded(variables) {
	// were any of these variables already expanded in a previous session?
	// if so: load the children
	const { expanded } = store.getState().variables;
	const toLoad = [];
	Object.keys(variables).forEach((path) => {
		if (expanded[path] && !variables[path].loaded) {
			toLoad.push(path);
		}
	});

	if (!toLoad.length) {
		return Promise.resolve(variables);
	}

	const process = () => {
		const path = toLoad.shift();
		if (!path) {
			return Promise.resolve(variables); // done
		}
		return _loadVariable(path)
			.then((loadedVariables) => {
				variables[path].loaded = true;
				Object.assign(variables, loadedVariables);
			})
			.then(process);
	};
	return process().then(ensureVariablesLoaded);
}

function getStacktrace() {
	if (!isStarted()) {
		return Promise.resolve([]);
	}
	return executeAndWait("-stack-list-frames").then((results) => {
		let stacktrace;
		results.forEach((r) => {
			if (r.type === "done" && r.value.stack) {
				stacktrace = r.value.stack.map((st) => {
					return {
						file: st.fullname && path.normalize(st.fullname),
						line: +st.line,
						func: st.func,
						addr: st.addr // TODO: id?
					};
				});
			}
		});
		// delete all existing variables in gdb
		// return unregisterVariables().then(() => {
		if (stacktrace) {
			return registerVariables().then((variables) => {
				// set the variables on the current active stack
				const { selectedStacktrace } = store.getState().gdb;
				stacktrace[selectedStacktrace].variables = variables;

				store.dispatch({ type: "UPDATE_STACKTRACE", stacktrace });

				return stacktrace;
			});
		}
		return [];
		// });
	});
}

export function selectStacktrace(index) {
	if (!isStarted()) {
		return Promise.resolve();
	}
	if (store.getState().gdb.selectedStacktrace === index) {
		// no need to change
		return Promise.resolve();
	}

	store.dispatch({ type: "SET_SELECTED_STACKTRACE", state: "waiting", index });

	return registerVariables().then((variables) => {
		store.dispatch({
			// TODO: pass on which variable has been loaded (always parent path?)
			type: "UPDATE_VARIABLES",
			variables,
			index: store.getState().gdb.selectedStacktrace
		});
	});

	// is this even needed? I don't think so...
	// return getStacktrace();

	/* it seems that it is deprecated to select a stack frame, but pass it to each call using --frame (and --thread)
	store.dispatch({ type: "SET_SELECTED_STACKTRACE", state: "busy", index });
	return executeAndWait(`frame ${index}`).then((output) => {
		store.dispatch({ type: "SET_SELECTED_STACKTRACE", state: "waiting", index });
		getStacktrace();
	}); */
}

// TODO: thread management!

export function isStarted() {
	const state = store.getState().gdb.state;
	return state !== "notStarted" && state !== "starting";
}

const nl = process.platform.startsWith("win") ? "\r\n" : "\n";
function wait(waitFor = "(gdb) " + nl) {
	return new Promise(function(resolve) {
		let output = "";
		const fn = (chunk) => {
			const txt = chunk.toString();
			output += txt;
			if (txt.endsWith(waitFor)) {
				const lines = output.split("\n");
				const results = lines.slice(0, lines.length-2).map(parseLine);
				resolve(results);
			} else {
				gdbProcess.stdout.once("data", fn);
			}
		};
		gdbProcess.stdout.once("data", fn);
		// gdbProcess.stderr.once("data", fn);
	});
}
function executeAndWait(cmd, waitFor) {
	const p = wait(waitFor);
	gdbProcess.stdin.write(cmd + "\n");
	return p;
}

// parseOutput parses the JSON like structured output of GDB
// unfortunately it is only JSON *like* ...
function parseOutput(text, o) {
	let isKey = true;
	let isRawValue = false;
	var escaped = false;
	let key = "";
	let value = "";

	function add() {
		if (Array.isArray(o)) {
			o.push(value);
		} else if (key) {
			o[key] = value;
		}
		isKey = !isKey;
		value = "";
		key = "";
	}

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (escaped) {
			escaped = false;
			value += char;
			continue;
		}

		if (char === "\"") {
			isRawValue = !isRawValue;
			if (!isRawValue) {
				add();
			}
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (isRawValue) {
			value += char;
			continue;
		}

		if (char === "=") {
			isKey = false;
			continue;
		} else if (char === "{") {
			value = {};
			i += parseOutput(text.substr(i+1), value);
			add();
			continue;
		} else if (char === "[") {
			value = [];
			i += parseOutput(text.substr(i+1), value);
			add();
			continue;
		} else if (char === "]" || char === "}") {
			return i+1;
		} else if (char === ",") {
			continue;
		}

		if (isKey) {
			key += char;
		}
	}
	return "";
}

const regLogStatement = /^~\"(.*)\n\"$/g;
function parseLine(line) {
	switch (line[0]) {
		case "~":
			// simple log statement
			var matches = regLogStatement.exec(line);
			console.log(matches && matches[1] || line);
			return undefined;
		// TODO: catch unprefixed lines (lines without a ~*= or so)
		//       they are most likely an stdout message...
		default:
			// output values
			// e.g. =breakpoint-created,bkpt={number="2",type="breakpoint",disp="keep"}
			var index = line.indexOf(",");
			var type = line.slice(1, index);
			var value = {};
			parseOutput(line.slice(index + 1), value);
			return { type, value };
	}
}
